import { afterEach, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  WorkspaceOwnership,
  FileRunStore,
  TaskManager,
} from '../../packages/agent-runtime/src/index';
import { SessionHost } from '../../packages/agent-host/src/index';
import { TaskHost } from '../../apps/desktop/src/main/tasks/task-host';
import { LocalPersistence } from '../../apps/desktop/src/main/storage/persistence';
import { TimelineService, FileChangeService, HookLifecycle } from '../../packages/tools/src/index';
import { runOptionsSchema, type ModelProvider } from '../../packages/agent-core/src/index';

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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function project() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-ownership-')));
  roots.push(root);
  await writeFile(path.join(root, 'file.txt'), 'before');
  return root;
}
const provider: ModelProvider = {
  countTokens: () => 1,
  async chat() {
    return { text: 'Inspected.', toolCalls: [] };
  },
  async *stream(request) {
    yield await this.chat(request);
  },
};

it('excludes other processes and reclaims the execution owner after a crash', async () => {
  const root = await project();
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { WorkspaceOwnership } from ${JSON.stringify(pathToFileURL(path.resolve('packages/agent-runtime/src/persistence/workspace-ownership.ts')).href)};
    new WorkspaceOwnership(process.env.TEST_WORKSPACE).acquire('child-task');
    process.send('ready');
    setInterval(() => {}, 1000);
  `,
    ],
    { env: { ...process.env, TEST_WORKSPACE: root }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  children.push(child);
  await once(child, 'message');
  expect(WorkspaceOwnership.current(root)?.taskId).toBe('child-task');
  expect(() => new WorkspaceOwnership(root).acquire('parent-task')).toThrow('Workspace busy');
  const cli = spawn(
    process.execPath,
    ['--import', 'tsx', path.resolve('apps/cli/src/index.ts'), 'run', 'inspect'],
    {
      env: {
        ...process.env,
        AGENT_WORKSPACE: root,
        AGENT_PROVIDER: 'compatible',
        AGENT_MODEL: 'fixture',
        AGENT_BASE_URL: 'http://127.0.0.1:1',
        AGENT_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(cli);
  let output = '';
  cli.stderr!.on('data', (chunk) => {
    output += chunk;
  });
  const [code] = await once(cli, 'exit');
  expect(code).toBe(1);
  expect(output).toContain('Workspace busy');
  const ended = once(child, 'exit');
  child.kill('SIGKILL');
  await ended;
  expect(WorkspaceOwnership.current(root)).toBeUndefined();
  const release = new WorkspaceOwnership(root).acquire('after-crash');
  expect(WorkspaceOwnership.current(root)?.taskId).toBe('after-crash');
  release();
  release();
  expect(WorkspaceOwnership.current(root)).toBeUndefined();
}, 10000);

it('preserves another host’s active history and excludes desktop and timeline writes', async () => {
  const root = await project();
  const tasks = new TaskManager(),
    task = tasks.create('running elsewhere', root);
  task.status = 'thinking';
  const store = new FileRunStore(root);
  store.saveTask(task);
  const timeline = new TimelineService(root);
  const id = await timeline.capture(task, undefined, 'before');
  const release = new WorkspaceOwnership(root).acquire(task.id);
  const host = new SessionHost({ root, provider });
  const desktop = new TaskHost(() => {});
  const persistence = new LocalPersistence(path.join(root, '.agent', 'desktop.sqlite'));
  persistence.task(task);
  desktop.initialize(persistence);
  desktop.config = {
    provider: 'compatible',
    model: 'fixture',
    apiKey: '',
    baseUrl: 'http://127.0.0.1:1',
  };
  try {
    expect(store.task(task.id)?.status).toBe('thinking');
    expect(persistence.tasks()[0]?.status).toBe('thinking');
    desktop.tasks.remove(task.id);
    await expect(host.start('second host')).rejects.toThrow('Workspace busy');
    expect(host.tasks.list()).toHaveLength(1);
    await expect(desktop.start('desktop task', root)).rejects.toThrow('Workspace busy');
    await expect(
      timeline.restore(id, 'code', new FileChangeService(root, { emit() {} })),
    ).rejects.toThrow('Workspace busy');
  } finally {
    release();
    desktop.close();
    persistence.close();
    await host.close();
  }
});

it('claims before asynchronous setup and releases after setup failure or completion', async () => {
  const root = await project();
  const host = new SessionHost({ root, provider });
  await writeFile(path.join(root, '.agent/hooks.json'), '{invalid');
  await expect(host.start('bad setup')).rejects.toThrow();
  expect(WorkspaceOwnership.current(root)).toBeUndefined();
  expect(host.tasks.list()[0]?.status).toBe('failed');
  await rm(path.join(root, '.agent/hooks.json'));
  let enteredSetup!: () => void;
  let resumeSetup!: () => void;
  const setupEntered = new Promise<void>((resolve) => {
    enteredSetup = resolve;
  });
  const setupGate = new Promise<void>((resolve) => {
    resumeSetup = resolve;
  });
  const load = HookLifecycle.prototype.load;
  const setup = vi.spyOn(HookLifecycle.prototype, 'load').mockImplementationOnce(async function (
    this: HookLifecycle,
    root,
  ) {
    enteredSetup();
    await setupGate;
    return load.call(this, root);
  });
  const first = host.start('first', runOptionsSchema.parse({ mode: 'plan' }));
  // Canonical path lookups may finish out of order. Hold real setup after it starts
  // so the assertion checks ownership during setup, not filesystem scheduling.
  void first.catch(() => {});
  try {
    await setupEntered;
    const owner = host.tasks.list().find((task) => task.prompt === 'first');
    expect(owner).toBeDefined();
    expect(WorkspaceOwnership.current(root)?.taskId).toBe(owner!.id);
    await expect(host.start('concurrent')).rejects.toThrow('Workspace busy');
    resumeSetup();
    const task = await first;
    await host.wait(task.id);
    expect(task.status).toBe('completed');
    expect(WorkspaceOwnership.current(root)).toBeUndefined();
  } finally {
    resumeSetup();
    await first.catch(() => {});
    await host.close();
    setup.mockRestore();
  }
});

it('rejects invalid launches without leaving idle tasks or changing the active task', async () => {
  const root = await project();
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const blocked: ModelProvider = {
    ...provider,
    async chat() {
      await gate;
      return { text: 'Inspected.', toolCalls: [] };
    },
    async *stream(request) {
      yield await this.chat(request);
    },
  };
  const host = new SessionHost({ root, provider: blocked });
  await expect(
    host.start('invalid isolation', runOptionsSchema.parse({ mode: 'plan' }), true),
  ).rejects.toThrow('Plan mode');
  expect(host.tasks.list()).toHaveLength(0);
  const task = await host.start('running', runOptionsSchema.parse({ mode: 'plan' }));
  try {
    await expect(host.start('second')).rejects.toThrow('Workspace busy');
    const before = task.status;
    await expect(host.start(task.prompt, task.runOptions, false, task)).rejects.toThrow(
      'already running',
    );
    expect(task.status).toBe(before);
    expect(host.tasks.list()).toHaveLength(1);
  } finally {
    unblock?.();
    await host.wait(task.id);
    await host.close();
  }
});
