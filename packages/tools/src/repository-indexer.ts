import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile, stat, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { AgentError, redactText, sensitivePath } from '@hikari/agent-core';
import { LogicalSandboxProvider, type SandboxProvider } from '@hikari/sandbox';
import { runProcess } from './process';
import { contentHash as hash } from './patch';

export class RepositoryIndexer {
  constructor(
    private root: string,
    private sandbox: SandboxProvider = new LogicalSandboxProvider(),
  ) {}
  async findFiles(glob = '*', signal: AbortSignal = new AbortController().signal) {
    const result = await runProcess(
      'rg',
      [
        '--files',
        '--hidden',
        '--path-separator',
        '/',
        '-g',
        glob,
        '-g',
        '!.git',
        '-g',
        '!.agent',
        '-g',
        '!node_modules',
      ],
      { cwd: this.root, env: this.sandbox.environment(), signal },
    );
    if (result.exitCode > 1) throw new AgentError('RG_FAILED', result.output);
    return result.output
      .trim()
      .split(/\r?\n/)
      .filter((file) => !!file && !sensitivePath(file))
      .slice(0, 10000);
  }
  async searchText(query: string, glob = '*', signal: AbortSignal = new AbortController().signal) {
    const files = await this.findFiles(glob, signal);
    const temporary = await mkdtemp(path.join(tmpdir(), 'hikari-search-'));
    let bytes = 0;
    try {
      for (const file of files) {
        signal.throwIfAborted();
        let source: string;
        try {
          source = await this.sandbox.resolve(this.root, file);
        } catch (error) {
          if (
            error instanceof AgentError &&
            ['SENSITIVE_PATH', 'PATH_ESCAPE', 'PROTECTED_PATH'].includes(error.code)
          )
            continue;
          throw error;
        }
        const info = await stat(source);
        if (info.size > 512000 || (bytes += info.size) > 64000000)
          throw new AgentError(
            'SEARCH_LIMIT',
            'Search input exceeds 512 KB per file or 64 MB total; narrow the file glob.',
          );
        const data = await readFile(source);
        if (data.includes(0)) continue;
        const destination = path.join(temporary, file);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, redactText(data.toString('utf8')), { mode: 0o600 });
      }
      const result = await runProcess(
        'rg',
        [
          '--hidden',
          '--line-number',
          '--path-separator',
          '/',
          '--max-count',
          '50',
          '--',
          query,
          '.',
        ],
        { cwd: temporary, env: this.sandbox.environment(), signal },
      );
      if (result.exitCode > 1) throw new AgentError('RG_FAILED', result.output);
      return result.output;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async findSymbol(name: string, signal?: AbortSignal) {
    return this.searchText(
      `(function|class|interface|type|const|def|func)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      '*',
      signal,
    );
  }
  async getFileSummary(file: string) {
    const target = await this.sandbox.resolve(this.root, file);
    const metadata = await stat(target);
    if (metadata.size > 512000) throw new AgentError('FILE_TOO_LARGE', 'File exceeds 512 KB');
    const text = await readFile(target, 'utf8');
    return {
      file,
      size: metadata.size,
      hash: hash(text),
      lines: text.split('\n').length,
      imports: [
        ...text.matchAll(/(?:from\s+|import\s+|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g),
      ]
        .map((match) => match[1])
        .slice(0, 80),
      symbols: text
        .split('\n')
        .filter((line) =>
          /^\s*(export\s+)?(async\s+)?(function|class|interface|type|def|func)\s/.test(line),
        )
        .slice(0, 60),
    };
  }
}
