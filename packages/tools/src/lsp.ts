import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { z } from 'zod';
import { lspConfigSchema, type ToolContext } from '@hikari/agent-core';
import { ToolRegistry } from '@hikari/agent-runtime';
import { LogicalSandboxProvider, type SandboxProvider, type ProcessLaunch } from '@hikari/sandbox';
import { installedManifests, expandPlugin } from './plugins';

/** Bounded stdio JSON-RPC. Servers cannot apply edits or execute client commands. */
export class LanguageServer {
  private child?: ChildProcessWithoutNullStreams;
  private launch?: ProcessLaunch;
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private versions = new Map<string, number>();
  private stderr = '';
  readonly diagnostics = new Map<string, unknown[]>();
  constructor(
    readonly root: string,
    readonly config: z.output<typeof lspConfigSchema>,
    private sandbox: SandboxProvider,
  ) {}
  private translate(value: unknown, outbound: boolean): unknown {
    if (Array.isArray(value)) return value.map((item) => this.translate(item, outbound));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (
          ['uri', 'rootUri', 'targetUri'].includes(key) &&
          typeof item === 'string' &&
          item.startsWith('file:')
        ) {
          for (const mapping of [...(this.launch?.pathMappings ?? [])].sort(
            (a, b) => b.from.length - a.from.length,
          )) {
            if (outbound) {
              const relative = path.relative(mapping.from, fileURLToPath(item));
              if (
                relative !== '..' &&
                !relative.startsWith('..' + path.sep) &&
                !path.isAbsolute(relative)
              )
                return [
                  key,
                  'file://' +
                    mapping.to +
                    (relative
                      ? '/' + relative.split(path.sep).map(encodeURIComponent).join('/')
                      : ''),
                ];
            } else {
              const pathname = decodeURIComponent(new URL(item).pathname);
              if (pathname === mapping.to || pathname.startsWith(mapping.to + '/'))
                return [
                  key,
                  pathToFileURL(path.join(mapping.from, pathname.slice(mapping.to.length))).href,
                ];
            }
          }
        }
        return [key, this.translate(item, outbound)];
      }),
    );
  }
  private send(message: unknown) {
    if (!this.child || this.child.stdin.destroyed)
      throw new Error('Language server is unavailable');
    const data = Buffer.from(JSON.stringify(this.translate(message, true)));
    this.child.stdin.write(`Content-Length: ${data.length}\r\n\r\n`);
    this.child.stdin.write(data);
  }
  private fail(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 4000000) throw new Error('Language server message exceeds 4 MB');
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(
        this.buffer.subarray(0, headerEnd).toString(),
      );
      const length = Number(match?.[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > 4000000)
        throw new Error('Invalid language server frame');
      if (this.buffer.length < headerEnd + 4 + length) return;
      const message = this.translate(
        JSON.parse(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString()),
        false,
      ) as {
        id?: number;
        method?: string;
        params?: { uri?: string; diagnostics?: unknown[]; items?: unknown[] };
        error?: { message?: string; code?: number };
        result?: unknown;
      };
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      if (typeof message.id === 'number' && !message.method) {
        const request = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error)
          request?.reject(
            Object.assign(new Error(String(message.error.message ?? 'LSP request failed')), {
              code: message.error.code,
            }),
          );
        else request?.resolve(message.result);
      } else if (
        message.method === 'textDocument/publishDiagnostics' &&
        typeof message.params?.uri === 'string'
      ) {
        this.diagnostics.set(
          message.params.uri,
          Array.isArray(message.params.diagnostics) ? message.params.diagnostics.slice(0, 100) : [],
        );
      } else if (message.id !== undefined && message.method) {
        const result =
          message.method === 'workspace/configuration'
            ? (message.params?.items ?? []).map(() => ({}))
            : message.method === 'workspace/applyEdit'
              ? { applied: false, failureReason: 'Hikari LSP clients are read-only' }
              : null;
        this.send({ jsonrpc: '2.0', id: message.id, result });
      }
    }
  }
  request(method: string, params: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const clean = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        this.pending.delete(id);
      };
      const abort = () => {
        try {
          this.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
        } catch {
          /* exited */
        }
        clean();
        reject(signal.reason ?? new Error('LSP cancelled'));
      };
      const timeout = setTimeout(() => {
        clean();
        reject(new Error(`LSP request timed out: ${method}`));
      }, 15000);
      this.pending.set(id, {
        resolve: (value) => {
          clean();
          resolve(value);
        },
        reject: (error) => {
          clean();
          reject(error);
        },
      });
      signal.addEventListener('abort', abort, { once: true });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clean();
        reject(error);
      }
    });
  }
  async start(signal: AbortSignal) {
    this.sandbox.validateCommand(this.config.command, this.config.args);
    this.launch = await this.sandbox.launch?.(this.config.command, this.config.args, this.root);
    this.child = spawn(
      this.launch?.command ?? this.config.command,
      this.launch?.args ?? this.config.args,
      {
        cwd: this.root,
        env: this.launch?.env ?? this.sandbox.environment(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        detached: process.platform !== 'win32',
      },
    );
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.consume(chunk);
      } catch (error) {
        this.fail(error as Error);
        void this.close();
      }
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', () =>
      this.fail(new Error('Language server exited' + (this.stderr ? ': ' + this.stderr : ''))),
    );
    try {
      await this.request(
        'initialize',
        {
          processId: process.pid,
          rootUri: pathToFileURL(this.root).href,
          capabilities: {
            textDocument: { publishDiagnostics: {}, diagnostic: {} },
            workspace: { configuration: true },
          },
          workspaceFolders: [
            { uri: pathToFileURL(this.root).href, name: path.basename(this.root) },
          ],
        },
        signal,
      );
      this.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async document(file: string) {
    const filename = await this.sandbox.resolve(this.root, file);
    if ((await stat(filename)).size > 2000000)
      throw new Error('LSP documents must be at most 2 MB');
    const text = await readFile(filename, 'utf8');
    if (Buffer.byteLength(text) > 2000000) throw new Error('LSP documents must be at most 2 MB');
    const uri = pathToFileURL(filename).href;
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.send({
      jsonrpc: '2.0',
      method: version === 1 ? 'textDocument/didOpen' : 'textDocument/didChange',
      params:
        version === 1
          ? { textDocument: { uri, languageId: this.config.languageId, version, text } }
          : { textDocument: { uri, version }, contentChanges: [{ text }] },
    });
    this.versions.set(uri, version);
    return uri;
  }
  async close() {
    this.fail(new Error('Language server closed'));
    const child = this.child;
    this.child = undefined;
    if (child?.pid) {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill();
      } catch {
        /* exited */
      }
      const timer = setTimeout(() => {
        try {
          if (process.platform !== 'win32') process.kill(-child.pid!, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* exited */
        }
      }, 800);
      timer.unref();
      child.once('close', () => clearTimeout(timer));
    }
    await this.launch?.cleanup();
  }
}
export async function registerLSPTools(
  registry: ToolRegistry,
  root: string,
  sandbox: SandboxProvider,
  configRoot = root,
) {
  root = await realpath(root);
  const filename = await new LogicalSandboxProvider().resolve(configRoot, '.agent/lsp.json');
  const text = await readFile(filename, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '[]';
    throw error;
  });
  if (text.length > 128000) throw new Error('LSP configuration exceeds 128 KB');
  const configs = z.array(lspConfigSchema).max(20).parse(JSON.parse(text));
  for (const { manifest, directory } of await installedManifests(configRoot))
    configs.push(
      ...manifest.lsp.map((config) => ({
        ...config,
        name: `${manifest.name}-${config.name}`,
        command: expandPlugin(config.command, directory),
        args: config.args.map((arg) => expandPlugin(arg, directory)),
      })),
    );
  const servers = new Map<string, Promise<LanguageServer>>();
  async function server(file: string, context: ToolContext) {
    const config = configs.find((config) => config.extensions.includes(path.extname(file)));
    if (!config) throw new Error(`No language server configured for ${path.extname(file)}`);
    if (!servers.has(config.name)) {
      const client = new LanguageServer(root, config, sandbox);
      servers.set(
        config.name,
        client
          .start(context.signal)
          .then(() => client)
          .catch((error) => {
            servers.delete(config.name);
            throw error;
          }),
      );
    }
    return servers.get(config.name)!;
  }
  if (configs.length)
    for (const [name, method] of Object.entries({
      lsp_definition: 'textDocument/definition',
      lsp_references: 'textDocument/references',
      lsp_hover: 'textDocument/hover',
      lsp_diagnostics: 'textDocument/diagnostic',
    })) {
      registry.register({
        name,
        description:
          'Use a configured language server for semantic navigation or diagnostics. Coordinates are zero-based. Starting a language server requires command approval.',
        permission: 'shell.execute',
        schema: z.object({
          path: z.string().min(1).max(2000),
          line: z.number().int().nonnegative().default(0),
          character: z.number().int().nonnegative().default(0),
        }),
        execute: async (input, context) => {
          const client = await server(input.path, context);
          const uri = await client.document(input.path);
          let result;
          try {
            result = await client.request(
              method,
              {
                textDocument: { uri },
                position: { line: input.line, character: input.character },
                context: { includeDeclaration: true },
              },
              context.signal,
            );
          } catch (error) {
            if (name !== 'lsp_diagnostics' || (error as { code?: number }).code !== -32601)
              throw error;
            result = {
              source: 'published',
              items: client.diagnostics.get(uri) ?? [],
              detail:
                'Server does not provide pull diagnostics; published results may still be pending.',
            };
          }
          const filter = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(filter).filter((item) => item !== undefined);
            if (value && typeof value === 'object') {
              const record = value as Record<string, unknown>;
              const location = record.uri ?? record.targetUri;
              if (typeof location === 'string') {
                try {
                  const relative = path.relative(root, fileURLToPath(location));
                  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
                } catch {
                  return undefined;
                }
              }
              return Object.fromEntries(
                Object.entries(record).map(([key, item]) => [key, filter(item)]),
              );
            }
            return value;
          };
          return { content: JSON.stringify(filter(result) ?? null) };
        },
      });
    }
  return {
    close: async () => {
      await Promise.allSettled([...servers.values()].map(async (client) => (await client).close()));
      servers.clear();
    },
  };
}
