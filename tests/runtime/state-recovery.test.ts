import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { StateStore } from '../../packages/agent-runtime/src/persistence/state-store';

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill('SIGKILL');
      await ended;
    }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function storage() {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-state-recovery-'));
  roots.push(root);
  return new StateStore(root);
}

it('excludes a live writer and reacquires its OS lock after a hard crash', async () => {
  const store = await storage();
  const source = pathToFileURL(
    path.resolve('packages/agent-runtime/src/persistence/state-store.ts'),
  ).href;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { StateStore } from ${JSON.stringify(source)};
    const store = new StateStore(process.env.TEST_STATE_ROOT);
    await store.transactionAsync('counter', async () => {
      store.set('counter', { value: 1 });
      process.send('locked');
      await new Promise(() => setInterval(() => {}, 1000));
    });
  `,
    ],
    {
      env: { ...process.env, TEST_STATE_ROOT: store.root },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  children.push(child);
  await once(child, 'message');
  expect(() => store.transaction('counter', () => store.set('counter', { value: 99 }))).toThrow(
    'locked',
  );
  const ended = once(child, 'exit');
  child.kill('SIGKILL');
  await ended;
  store.transaction('counter', () => {
    expect(store.get('counter')).toEqual({ value: 1 });
    store.set('counter', { value: 2 });
  });
  expect(store.get('counter')).toEqual({ value: 2 });
}, 10000);

it('releases failed asynchronous transactions and refuses unsafe or legacy locks', async () => {
  const store = await storage();
  await expect(
    store.transactionAsync('counter', async () => {
      throw new Error('failed update');
    }),
  ).rejects.toThrow('failed update');
  expect(store.transaction('counter', () => 'available')).toBe('available');
  await writeFile(path.join(store.directory, 'legacy.json.lock'), '');
  expect(() => store.transaction('legacy', () => {})).toThrow('requires inspection');
  await writeFile(path.join(store.root, 'outside'), 'preserve');
  await symlink(
    path.join(store.root, 'outside'),
    path.join(store.directory, 'unsafe.json.lock.sqlite'),
  );
  expect(() => store.transaction('unsafe', () => {})).toThrow('Invalid');
});
