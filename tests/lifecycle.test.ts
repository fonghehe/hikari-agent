import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalPersistence } from '../apps/desktop/src/main/persistence';
import { TaskHost } from '../apps/desktop/src/main/task-host';
import {
  TaskManager,
  EventBus,
  ContextManager,
  MemoryManager,
} from '../packages/agent-runtime/src';
import type { ModelProvider } from '../packages/agent-core/src';
it('restores persisted history, marks interrupted tasks failed, and retains grants', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-persist-'));
  let store = new LocalPersistence(path.join(root, 'test.sqlite'));
  try {
    const task = new TaskManager().create('recover', root);
    task.runOptions = { mode: 'plan', maxSteps: 12 };
    const bus = new EventBus(task);
    bus.emit('agent.state', { state: 'planning' });
    bus.emit('plan.updated', {
      steps: [{ id: 'inspect', text: 'Inspect files', status: 'pending' }],
    });
    store.task(task);
    store.addGrant('exact-request');
    await store.close();
    store = new LocalPersistence(path.join(root, 'test.sqlite'));
    const host = new TaskHost(() => {});
    host.initialize(store);
    expect(host.tasks.get(task.id).status).toBe('failed');
    expect(host.tasks.get(task.id).runOptions).toEqual({ mode: 'plan', maxSteps: 12 });
    expect(host.tasks.get(task.id).plan?.steps[0]?.text).toBe('Inspect files');
    expect(store.hasGrant('exact-request')).toBe(true);
    expect(store.hasGrant('different-request')).toBe(false);
    expect(host.tasks.get(task.id).events.at(-1)?.type).toBe('agent.failed');
    host.close();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('rejects invalid state transitions and cannot revive terminal tasks', () => {
  const task = new TaskManager().create('state', '/tmp');
  const bus = new EventBus(task);
  expect(() => bus.emit('agent.state', { state: 'completed' })).toThrow('idle -> completed');
  bus.emit('agent.state', { state: 'planning' });
  bus.emit('agent.state', { state: 'failed' });
  expect(() => bus.emit('agent.state', { state: 'thinking' })).toThrow('failed -> thinking');
});
it('context compaction preserves tool call/result pairing and the newest result', () => {
  const context = new ContextManager('system', 1200);
  context.add({ role: 'user', content: 'Do the task' });
  for (let i = 0; i < 5; i++) {
    context.add({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: String(i), name: 'read_file', input: { path: 'a' } }],
    });
    context.add({ role: 'tool', toolCallId: String(i), content: 'output '.repeat(100) });
  }
  const provider = { countTokens: (text: string) => text.length } as ModelProvider;
  const result = context.build(provider, new MemoryManager());
  for (const message of result.filter((m) => m.role === 'tool'))
    expect(result.some((m) => m.toolCalls?.some((call) => call.id === message.toolCallId))).toBe(
      true,
    );
  expect(result.at(-1)?.toolCallId).toBe('4');
});

it('rejects follow-ups to an active task or a different workspace before creating a task', async () => {
  const host = new TaskHost(() => {});
  host.config = {
    provider: 'compatible',
    model: 'fixture',
    apiKey: '',
    baseUrl: 'http://127.0.0.1:1',
  };
  const task = host.tasks.create('previous', '/one');
  await expect(host.start('follow-up', '/one', false, task.id)).rejects.toThrow(
    'Finish the previous task',
  );
  const bus = new EventBus(task);
  bus.emit('agent.state', { state: 'planning' });
  bus.emit('agent.state', { state: 'failed' });
  await expect(host.start('follow-up', '/two', false, task.id)).rejects.toThrow(
    'open its workspace',
  );
  await expect(host.start('follow-up', '/one', true, task.id)).rejects.toThrow(
    'previous workspace or worktree',
  );
  expect(host.tasks.list()).toHaveLength(1);
  host.close();
});
