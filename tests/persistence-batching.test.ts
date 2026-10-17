import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalPersistence } from '../apps/desktop/src/main/persistence';
import { EventBus, TaskManager } from '../packages/agent-runtime/src';
import { SQLiteRepository, ConflictError } from '../packages/database/src';

it('batches streaming events while committing tool boundaries and the latest task immediately', async () => {
  const store = new LocalPersistence(':memory:');
  try {
    const task = new TaskManager().create('stream', '/fixture');
    const events = new EventBus(task);
    const writes = vi.spyOn(store.repository, 'putManySync');
    events.subscribe((event) => store.task(task, event, []));
    for (let index = 0; index < 100; index++)
      events.emit('agent.message.delta', { text: String(index) });
    expect(writes).not.toHaveBeenCalled();
    events.emit('tool.started', { id: 'call' });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(store.get('tasks', task.id)?.version).toBe(1);
    const saved = store.get('tasks', task.id);
    expect(saved).toBeDefined();
    expect((saved!.data as typeof task).events).toHaveLength(101);
    expect(store.repository.listSync('events', 'local')).toHaveLength(101);
    expect(store.get('changes', task.id)?.version).toBe(1);
  } finally {
    await store.close();
  }
});

it('flushes other tasks on the timer even when a critical event flushes only one task', async () => {
  vi.useFakeTimers();
  const store = new LocalPersistence(':memory:');
  try {
    const tasks = new TaskManager();
    const first = tasks.create('one', '/one'),
      second = tasks.create('two', '/two');
    const buses = [first, second].map((task) => new EventBus(task));
    for (const events of buses) {
      const task = events.task;
      events.subscribe((event) => store.task(task, event));
      events.emit('tool.stdout', { chunk: task.prompt });
    }
    buses[0]!.emit('tool.completed');
    expect(store.get('tasks', first.id)).toBeDefined();
    expect(store.get('tasks', second.id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(store.get('tasks', second.id)).toBeDefined();
  } finally {
    await store.close();
    vi.useRealTimers();
  }
});

it('flushes pending presentation events before closing and can reopen them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-batch-'));
  const task = new TaskManager().create('close', root);
  const filename = path.join(root, 'state.sqlite');
  const store = new LocalPersistence(filename);
  try {
    const events = new EventBus(task);
    events.subscribe((event) => store.task(task, event));
    events.emit('tool.stdout', { chunk: 'last output' });
    await store.close();
    const reopened = new LocalPersistence(filename);
    try {
      expect(reopened.tasks()[0]?.events[0]?.data.chunk).toBe('last output');
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rolls back every record in a batch if a later optimistic update conflicts', async () => {
  const repository = new SQLiteRepository(':memory:');
  try {
    repository.putSync('tasks', 'local', 'old', {}, 0);
    expect(() =>
      repository.putManySync([
        { collection: 'events', owner: 'local', id: 'new', data: {}, expectedVersion: 0 },
        { collection: 'tasks', owner: 'local', id: 'old', data: {}, expectedVersion: 0 },
      ]),
    ).toThrow(ConflictError);
    expect(repository.getSync('events', 'local', 'new')).toBeUndefined();
    expect(repository.getSync('tasks', 'local', 'old')?.version).toBe(1);
  } finally {
    await repository.close();
  }
});
