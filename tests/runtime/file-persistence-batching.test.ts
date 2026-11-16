import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventBus, FileRunStore, TaskManager } from '../../packages/agent-runtime/src/index';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-file-batch-'));
  roots.push(root);
  const store = new FileRunStore(root);
  const task = new TaskManager().create('stream', root);
  const events = new EventBus(task);
  events.subscribe((event) => store.recordTask(task, event));
  return { root, store, task, events };
}

it('coalesces file-store presentation writes but persists tool boundaries immediately', async () => {
  const { root, store, task, events } = await fixture();
  const writes = vi.spyOn(store, 'saveTask');
  for (let index = 0; index < 200; index++) events.emit('agent.message.delta', { text: 'x' });
  expect(new FileRunStore(root).task(task.id)).toBeUndefined();
  expect(writes).not.toHaveBeenCalled();
  events.emit('tool.started', { id: 'read' });
  expect(new FileRunStore(root).task(task.id)?.events).toHaveLength(201);
  expect(writes).toHaveBeenCalledTimes(1);
  store.close();
});

it('flushes another pending task on time after a single-task boundary', async () => {
  const { root, store, task, events } = await fixture();
  vi.useFakeTimers();
  const other = new TaskManager().create('other', root);
  store.recordTask(other, {
    id: 'delta',
    taskId: other.id,
    agentId: other.agentId,
    timestamp: new Date().toISOString(),
    type: 'tool.stdout',
    data: { chunk: 'saved' },
  });
  events.emit('agent.message.delta', { text: 'first' });
  events.emit('tool.completed');
  expect(new FileRunStore(root).task(task.id)).toBeDefined();
  expect(new FileRunStore(root).task(other.id)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(100);
  expect(new FileRunStore(root).task(other.id)?.prompt).toBe('other');
  store.close();
});

it('flushes pending text on close and before checkpoint persistence', async () => {
  const { root, store, task, events } = await fixture();
  events.emit('agent.message.delta', { text: 'before checkpoint' });
  store.save(task.id, {
    version: 1,
    messages: [],
    memory: [],
    summary: {
      modelSteps: 0,
      toolCalls: 0,
      toolFailures: 0,
      durationMs: 0,
      filesChanged: [],
      tests: [],
    },
    revision: 0,
    testedRevision: {},
    pending: [],
    queued: [],
    done: false,
    updatedAt: new Date().toISOString(),
  });
  expect(new FileRunStore(root).task(task.id)?.events).toHaveLength(1);
  events.emit('agent.message.delta', { text: 'last text' });
  store.close();
  store.close();
  const reopened = new FileRunStore(root);
  expect(reopened.task(task.id)?.events).toHaveLength(2);
  expect(reopened.load(task.id)?.version).toBe(1);
});

it('keeps a critical storage failure sticky so a later checkpoint cannot hide it', async () => {
  const { store, task } = await fixture();
  const writes = vi.spyOn(store, 'saveTask').mockImplementationOnce(() => {
    throw new Error('disk unavailable');
  });
  expect(() => store.recordTask(task)).toThrow('disk unavailable');
  writes.mockRestore();
  expect(() => store.flush()).toThrow('disk unavailable');
  expect(() => store.close()).toThrow('disk unavailable');
});
