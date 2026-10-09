import { it, expect } from 'vitest';
import { PermissionManager } from '../packages/sandbox/src';
it('scopes grants to exact workspace, tool and arguments', async () => {
  let approvals = 0;
  const manager = new PermissionManager({ emit() {} }, async () => {
    approvals++;
    return 'session';
  });
  const request = {
    id: '1',
    taskId: 't',
    tool: 'shell',
    permission: 'shell.execute' as const,
    input: { command: 'npm', args: ['test'] },
    workspace: '/one',
  };
  const signal = new AbortController().signal;
  expect(await manager.check(request, signal)).toBe(true);
  await manager.check(request, signal);
  expect(approvals).toBe(1);
  await manager.check({ ...request, workspace: '/two' }, signal);
  await manager.check({ ...request, input: { command: 'npm', args: ['install'] } }, signal);
  expect(approvals).toBe(3);
  expect(await manager.check({ ...request, permission: 'shell.system' }, signal)).toBe(false);
});

it('denies destructive patch execution through the runner while allowing preview', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { AgentRunner, ContextManager, EventBus, MemoryManager, TaskManager, ToolRegistry } =
    await import('../packages/agent-runtime/src');
  const { registerGitTools, FileChangeService, hash } = await import('../packages/tools/src');
  const root = await mkdtemp(path.join(tmpdir(), 'forge-delete-'));
  try {
    await writeFile(path.join(root, 'a.txt'), 'keep\n');
    const tasks = new TaskManager();
    const task = tasks.create('delete fixture', root);
    const events = new EventBus(task);
    const tools = new ToolRegistry();
    const changes = new FileChangeService(root, events);
    registerGitTools(tools, changes);
    const input = {
      diff: '--- a/a.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-keep\n',
      files: [{ path: 'a.txt', expectedHash: hash('keep\n') }],
    };
    const calls = [true, false].map((previewOnly, i) => ({
      text: '',
      toolCalls: [{ id: String(i), name: 'apply_patch', input: { ...input, previewOnly } }],
    }));
    let approvals = 0;
    const permissions = new PermissionManager(events, async (request) => {
      expect(request.permission).toBe('filesystem.delete');
      approvals++;
      return 'deny';
    });
    await new AgentRunner(task, {
      tasks,
      events,
      tools,
      context: new ContextManager('fixture'),
      memory: new MemoryManager(),
      permissions,
      provider: {
        chat: async () => calls.shift() ?? { text: 'denied', toolCalls: [] },
        async *stream(request) {
          yield await this.chat(request);
        },
        countTokens: (text) => text.length,
      },
    }).run();
    expect(approvals).toBe(1);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('keep\n');
    expect(changes.history).toHaveLength(0);
    expect(task.events.some((event) => event.type === 'tool.completed')).toBe(true);
    expect(task.events.some((event) => event.type === 'permission.denied')).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
