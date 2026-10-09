import { createHash } from 'node:crypto';
import { SQLiteRepository } from '@hikari/database';
import type { Collection } from '@hikari/database';
import type { Task, AgentEvent } from '@hikari/agent-core';
import type { RunnerCheckpoint, MemoryEntry } from '@hikari/agent-runtime';
import { parseCheckpoint } from '@hikari/agent-runtime';
import type { Change } from '@hikari/tools';
export class LocalPersistence {
  readonly repository: SQLiteRepository;
  private vectorSnapshots = new Map<string, Record<string, number[]>>();
  constructor(filename: string) {
    this.repository = new SQLiteRepository(filename);
  }
  get(collection: Collection, id: string) {
    return this.repository.getSync(collection, 'local', id);
  }
  save(collection: Collection, id: string, data: unknown) {
    const old = this.get(collection, id);
    this.repository.putSync(collection, 'local', id, data, old?.version ?? 0);
  }
  tasks() {
    const tasks: Task[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = this.repository.listSync('tasks', 'local', { offset });
      tasks.push(...page.map((record) => record.data as Task));
      if (page.length < 500) return tasks;
    }
  }
  task(task: Task, event?: AgentEvent, changes?: Change[]) {
    this.save('tasks', task.id, task);
    if (event) this.save('events', event.id, event);
    if (changes) this.save('changes', task.id, changes);
  }
  checkpoints = {
    load: (id: string): RunnerCheckpoint | undefined => {
      const record = this.get('messages', `checkpoint:${id}`);
      return record ? parseCheckpoint(record.data) : undefined;
    },
    save: (id: string, checkpoint: RunnerCheckpoint) =>
      this.save('messages', `checkpoint:${id}`, checkpoint),
  };
  memories = {
    list: (scope: string): MemoryEntry[] =>
      (this.get('messages', `memory:${scope}`)?.data as MemoryEntry[] | undefined) ?? [],
    put: (scope: string, entry: MemoryEntry) =>
      this.save('messages', `memory:${scope}`, [
        ...this.memories.list(scope).filter((item) => item.id !== entry.id),
        entry,
      ]),
    remove: (scope: string, id: string) =>
      this.save(
        'messages',
        `memory:${scope}`,
        this.memories.list(scope).filter((item) => item.id !== id),
      ),
  };
  vectors(scope: string) {
    const identity = `vectors:${scope}`;
    if (!this.vectorSnapshots.has(identity))
      this.vectorSnapshots.set(
        identity,
        (this.get('messages', identity)?.data ?? {}) as Record<string, number[]>,
      );
    const putMany = (entries: [string, number[]][]) => {
      const values = this.vectorSnapshots.get(identity)!;
      for (const [key, vector] of entries) {
        delete values[key];
        values[key] = vector;
      }
      const snapshot = Object.fromEntries(Object.entries(values).slice(-2000));
      this.save('messages', identity, snapshot);
      this.vectorSnapshots.set(identity, snapshot);
    };
    return {
      get: (key: string) => this.vectorSnapshots.get(identity)![key],
      put: (key: string, vector: number[]) => putMany([[key, vector]]),
      putMany,
    };
  }
  hasGrant(key: string) {
    return !!this.get('grants', createHash('sha256').update(key).digest('hex'));
  }
  addGrant(key: string) {
    this.save('grants', createHash('sha256').update(key).digest('hex'), {
      allowed: true,
      description: key,
    });
  }
  close() {
    return this.repository.close();
  }
}
