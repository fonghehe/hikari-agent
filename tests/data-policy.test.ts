import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LogicalSandboxProvider } from '../packages/sandbox/src';
import { ContextManager, MemoryManager, ToolObservations } from '../packages/agent-runtime/src';
import type { ModelProvider } from '../packages/agent-core/src';
import { HybridRetriever } from '../packages/agent-runtime/src/retrieval';
import {
  RepositoryIndexer,
  FileChangeService,
  registerFileTools,
  hash,
} from '../packages/tools/src';
import { redactText, sensitivePath } from '../packages/agent-core/src';
import { RedactedOutputStream } from '../packages/tools/src/output-stream';
import { ToolRegistry } from '../packages/agent-runtime/src';
import { sanitizeMessage, type ToolContext } from '../packages/agent-core/src';
import { prepareAttachment } from '../apps/desktop/src/main/attachments';
import { sensitiveFiles } from '../packages/sandbox/src/sensitive-files';

const secret = 'sk-' + 'syntheticCredential'.repeat(3);
it('keeps split credentials and multiline private keys out of live command output', () => {
  let output = '';
  const stream = new RedactedOutputStream((text) => {
    output += text;
  });
  stream.push(secret.slice(0, 7));
  stream.push(secret.slice(7) + '\n');
  stream.push('-----BEGIN PRIVATE KEY-----\nopaque-private\n');
  stream.push('-----END PRIVATE KEY-----\nnormal text');
  stream.flush();
  expect(output.includes(secret)).toBe(false);
  expect(output.includes('opaque-private')).toBe(false);
  expect(output).toContain('normal text');
});
const provider: ModelProvider = {
  countTokens: (text) => Math.ceil(text.length / 4),
  chat: async () => ({ text: '', toolCalls: [] }),
  async *stream() {
    yield { text: '', toolCalls: [] };
  },
};

it('blocks sensitive files and symlink aliases while allowing template configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-policy-'));
  try {
    await writeFile(path.join(root, '.env'), 'AGENT_API_KEY=' + secret);
    await writeFile(path.join(root, '.env.example'), 'AGENT_API_KEY=');
    await mkdir(path.join(root, 'src'));
    await symlink(path.join(root, '.env'), path.join(root, 'src', 'config.txt'));
    const sandbox = new LogicalSandboxProvider();
    await expect(sandbox.resolve(root, '.env')).rejects.toThrow('Sensitive');
    await expect(sandbox.resolve(root, 'src/config.txt')).rejects.toThrow('Sensitive');
    await expect(sandbox.resolve(root, '.env.example')).resolves.toContain('.env.example');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('sanitizes restored contexts, provider replay fields and memory without breaking IDs or media', () => {
  const context = new ContextManager('System ' + secret);
  const memory = new MemoryManager();
  memory.restore([['Fact', secret]]);
  context.restore([
    {
      role: 'assistant',
      content: secret,
      providerData: {
        rawAssistantContent: secret,
        gemini: { content: [{ text: secret, thoughtSignature: 'opaque-signature' }] },
      },
      toolCalls: [
        { id: 'call-1', name: 'read_file', input: { path: 'src/main.ts', apiKey: secret } },
      ],
      images: [{ mimeType: 'image/png', data: 'opaque-media' }],
      references: [{ name: 'notes.txt', kind: 'text', text: secret }],
    },
  ]);
  const messages = context.build(provider, memory);
  expect(JSON.stringify(messages)).not.toContain(secret);
  expect(messages[1]?.toolCalls?.[0]?.id).toBe('call-1');
  expect(messages[1]?.images?.[0]?.data).toBe('opaque-media');
  expect(JSON.stringify(messages)).toContain('opaque-signature');
  expect(JSON.stringify(context.snapshot())).not.toContain(secret);
});

it('sanitizes full saved observations before paging can split a private key block', () => {
  let saved = '';
  const observations = new ToolObservations(randomUUID(), {
    saveOutput: (_task, _id, text) => {
      saved = text;
    },
    loadOutput: () => saved,
  });
  observations.capture(
    'prefix '.repeat(6000) +
      '\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\n' +
      secret,
  );
  expect(saved).not.toContain(secret);
  expect(saved).not.toContain('private-material');
});

it('protects embedding requests and returned metadata', async () => {
  const sent: string[] = [];
  const docs = await new HybridRetriever([{ text: secret, metadata: { content: secret } }], 1, {
    embedDocuments: async (texts) => {
      sent.push(...texts);
      return texts.map(() => [1, 0]);
    },
    embedQuery: async (query) => {
      sent.push(query);
      return [1, 0];
    },
  }).invoke(secret);
  expect(sent.some((text) => text.includes(secret))).toBe(false);
  expect(JSON.stringify(docs).includes(secret)).toBe(false);
});

it('excludes sensitive paths from search and exact-byte code snapshots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-policy-search-'));
  try {
    await writeFile(path.join(root, '.env'), 'needle=private');
    await writeFile(path.join(root, '.env.example'), 'needle=template');
    await writeFile(path.join(root, 'config.PEM'), 'needle=private');
    await writeFile(path.join(root, 'notes.txt'), 'needle=public');
    const index = new RepositoryIndexer(root);
    const found = await index.findFiles();
    expect(found).not.toContain('.env');
    expect(found).not.toContain('config.PEM');
    const result = await index.searchText('needle');
    expect(result).toContain('template');
    expect(result).toContain('public');
    expect(result).not.toContain('private');
    const changes = new FileChangeService(root, { emit: () => {} });
    const snapshot = await changes.snapshotExternal();
    expect(snapshot.has('.env')).toBe(false);
    expect(snapshot.has('notes.txt')).toBe(true);
    for (const name of [
      '.ENV.local',
      'keys/private.KEY',
      '.aws/credentials',
      'C:\\repo\\.ssh\\id_rsa',
    ])
      expect(sensitivePath(name)).toBe(true);
    expect(
      redactText('-----BEGIN RSA PRIVATE KEY-----\nopaque\n-----END RSA PRIVATE KEY-----'),
    ).not.toContain('opaque');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('redacts full authorization values while preserving normal source expressions and tool schemas', () => {
  for (const value of [
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'authorization: bearer opaqueCredentialForTesting',
  ]) {
    expect(redactText(JSON.stringify({ output: value }))).not.toContain(value.split(' ').at(-1));
  }
  const source = 'const token = countTokens(input);\nconst secret = await loadFromKeychain();';
  expect(redactText(source)).toBe(source);
  const input = { passwordPolicy: { minLength: 12 }, apiKey: { type: 'string' }, tokenCount: 1 };
  expect(
    sanitizeMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'one', name: 'custom', input }],
    }).toolCalls?.[0]?.input,
  ).toEqual(input);
  expect(sensitivePath('.docker/config.json')).toBe(true);
});

it('sanitizes source before tiny reads and preserves its original write hash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-tiny-reads-'));
  try {
    const source = 'prefix ' + secret + ' tail';
    await writeFile(path.join(root, 'notes.txt'), source);
    const tools = new ToolRegistry();
    registerFileTools(tools, new LogicalSandboxProvider());
    const read = tools.get('read_file');
    const ctx: ToolContext = {
      taskId: randomUUID(),
      workspace: root,
      signal: new AbortController().signal,
      events: { emit: () => {} },
    };
    let combined = '',
      offset: number | null = 0;
    while (offset !== null) {
      const result = JSON.parse(
        (await read.execute(read.parse({ path: 'notes.txt', offset, limit: 1 }), ctx)).content,
      );
      expect(result.hash).toBe(hash(source));
      combined += result.content;
      offset = result.nextOffset;
    }
    expect(combined.includes(secret)).toBe(false);
    expect(combined).toContain('[REDACTED]');
    const write = tools.get('write_file');
    await expect(
      write.execute(
        write.parse({ path: 'notes.txt', content: combined, expectedHash: hash(source) }),
        ctx,
      ),
    ).rejects.toThrow('redacted placeholders');
    expect(
      await (await import('node:fs/promises')).readFile(path.join(root, 'notes.txt'), 'utf8'),
    ).toBe(source);
    await writeFile(
      path.join(root, 'private-notes.txt'),
      '-----BEGIN PRIVATE KEY-----\nsynthetic-hidden-material\n-----END PRIVATE KEY-----',
    );
    expect(await new RepositoryIndexer(root).searchText('synthetic-hidden-material')).not.toContain(
      'synthetic-hidden-material',
    );
    for (const directory of ['node_modules/pkg', '.agent', 'dist']) {
      await mkdir(path.join(root, directory), { recursive: true });
      await writeFile(path.join(root, directory, '.env'), 'PASSWORD=synthetic-only');
    }
    expect((await sensitiveFiles(root)).filter((name) => name.endsWith('.env'))).toHaveLength(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('redacts a whole PEM before attachment chunking and embedding preparation', async () => {
  const body = 'synthetic-private-material'.repeat(300);
  const document = await prepareAttachment({
    name: 'notes.txt',
    bytes: Buffer.from(
      '-----BEGIN RSA PRIVATE KEY-----\n' + body + '\n-----END RSA PRIVATE KEY-----',
    ),
  });
  expect(document.text?.includes('synthetic-private-material')).toBe(false);
  expect(document.chunks?.some((chunk) => chunk.text.includes('synthetic-private-material'))).toBe(
    false,
  );
});
