import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LanguageServer } from '../../packages/tools/src/lsp';
import { LogicalSandboxProvider } from '../../packages/sandbox/src/index';

const roots: string[] = [];
const clients: LanguageServer[] = [];
const pids: number[] = [];
const signal = new AbortController().signal;

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  for (const pid of pids.splice(0)) {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
    await expect.poll(() => alive(pid)).toBe(false);
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: { ignoreTerm?: boolean; cleanup?: () => Promise<void> } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-lsp-lifecycle-'));
  roots.push(root);
  const script = path.join(root, 'server.mjs');
  const pidFile = path.join(root, 'pid');
  await writeFile(
    script,
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
${options.ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
process.stdin.on('data', (chunk) => {
  if (chunk.includes('fixture/exit')) process.exit(0);
});
await import(${JSON.stringify(pathToFileURL(path.resolve('tests/fixtures/lsp-server.mjs')).href)});
`,
  );
  let cleanupCalls = 0;
  const aliveAtCleanup: boolean[] = [];
  let pid = 0;
  const sandbox = Object.assign(new LogicalSandboxProvider(), {
    async launch() {
      return {
        command: process.execPath,
        args: [script],
        env: new LogicalSandboxProvider().environment(),
        async cleanup() {
          cleanupCalls++;
          aliveAtCleanup.push(alive(pid));
          await options.cleanup?.();
        },
      };
    },
  });
  const client = new LanguageServer(
    root,
    {
      name: 'lifecycle',
      command: process.execPath,
      args: [script],
      extensions: ['.ts'],
      languageId: 'typescript',
    },
    sandbox,
  );
  clients.push(client);
  await client.start(signal);
  pid = Number(await readFile(pidFile, 'utf8'));
  pids.push(pid);
  return { client, pid, aliveAtCleanup, cleanupCalls: () => cleanupCalls };
}

it('waits for the LSP process to close before releasing its sandbox launch', async () => {
  const { client, pid, aliveAtCleanup } = await fixture();
  await client.close();
  expect(alive(pid)).toBe(false);
  expect(aliveAtCleanup).toEqual([false]);
});

it('shares process shutdown and asynchronous sandbox cleanup across concurrent closes', async () => {
  let release!: () => void;
  const cleanupGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { client, cleanupCalls } = await fixture({
    async cleanup() {
      started();
      await cleanupGate;
    },
  });
  const first = client.close();
  const second = client.close();
  try {
    await cleanupStarted;
    expect(cleanupCalls()).toBe(1);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  await client.close();
  expect(cleanupCalls()).toBe(1);
});

it.runIf(process.platform !== 'win32')(
  'force kills an LSP server that ignores termination before releasing its launch',
  async () => {
    const { client, pid, aliveAtCleanup } = await fixture({ ignoreTerm: true });
    await client.close();
    expect(alive(pid)).toBe(false);
    expect(aliveAtCleanup).toEqual([false]);
  },
);

it('can close after the server exits independently', async () => {
  const { client, aliveAtCleanup } = await fixture();
  await expect(client.request('fixture/exit', {}, signal)).rejects.toThrow(
    'Language server exited',
  );
  await client.close();
  expect(aliveAtCleanup).toEqual([false]);
});

it('releases a failed spawn once without waiting for a missing pid', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-lsp-lifecycle-'));
  roots.push(root);
  let cleanupCalls = 0;
  const command = path.join(root, 'missing-lsp');
  const sandbox = Object.assign(new LogicalSandboxProvider(), {
    async launch() {
      return {
        command,
        args: [],
        env: new LogicalSandboxProvider().environment(),
        async cleanup() {
          cleanupCalls++;
        },
      };
    },
  });
  const client = new LanguageServer(
    root,
    {
      name: 'missing',
      // Keep validation independent of Windows' RUNNER~1 temporary directory.
      // The launch adapter still supplies the nonexistent absolute executable.
      command: 'missing-lsp',
      args: [],
      extensions: ['.ts'],
      languageId: 'typescript',
    },
    sandbox,
  );
  clients.push(client);
  await expect(client.start(signal)).rejects.toThrow('ENOENT');
  await Promise.all([client.close(), client.close()]);
  expect(cleanupCalls).toBe(1);
});
