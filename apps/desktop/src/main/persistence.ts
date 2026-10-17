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
  private pending = new Map<string, { task: Task; events: AgentEvent[]; changes?: Change[] }>();
  private flushTimer?: ReturnType<typeof setTimeout>;
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
    this.flush();
    const tasks: Task[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = this.repository.listSync('tasks', 'local', { offset });
      tasks.push(...page.map((record) => record.data as Task));
      if (page.length < 500) return tasks;
    }
  }
  task(task: Task, event?: AgentEvent, changes?: Change[]) {
    const entry = this.pending.get(task.id) ?? { task, events: [] };
    entry.task = task;
    if (event) entry.events.push(event);
    if (changes) entry.changes = changes;
    this.pending.set(task.id, entry);
    // Presentation updates can share a transaction; all execution boundaries stay durable.
    if (
      !event ||
      ![
        'agent.message.delta',
        'tool.stdout',
        'agent.thinking',
        'git.diff.updated',
        'agent.usage',
      ].includes(event.type)
    ) {
      this.flush(task.id);
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 100);
      this.flushTimer.unref();
    }
  }
  flush(taskId?: string) {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const entries = taskId ? [...this.pending].filter(([id]) => id === taskId) : [...this.pending];
    const writes = entries.flatMap(([, entry]) => {
      const records: { collection: Collection; id: string; data: unknown }[] = [
        { collection: 'tasks', id: entry.task.id, data: entry.task },
        ...entry.events.map((event) => ({
          collection: 'events' as const,
          id: event.id,
          data: event,
        })),
      ];
      if (entry.changes)
        records.push({ collection: 'changes', id: entry.task.id, data: entry.changes });
      return records.map((record) => ({
        ...record,
        owner: 'local',
        expectedVersion: this.get(record.collection, record.id)?.version ?? 0,
      }));
    });
    this.repository.putManySync(writes);
    for (const [id] of entries) this.pending.delete(id);
    if (this.pending.size) {
      this.flushTimer = setTimeout(() => this.flush(), 100);
      this.flushTimer.unref();
    }
  }
  checkpoints = {
    load: (id: string): RunnerCheckpoint | undefined => {
      const record = this.get('messages', `checkpoint:${id}`);
      return record ? parseCheckpoint(record.data) : undefined;
    },
    save: (id: string, checkpoint: RunnerCheckpoint) => {
      this.flush(id);
      this.save('messages', `checkpoint:${id}`, checkpoint);
    },
    saveOutput: (taskId: string, id: string, content: string) =>
      this.save('tool_calls', `output:${taskId}:${id}`, content),
    loadOutput: (taskId: string, id: string) =>
      this.get('tool_calls', `output:${taskId}:${id}`)?.data as string | undefined,
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
  removeTaskOutputs(taskId: string) {
    this.flush(taskId);
    this.repository.removePrefixSync('tool_calls', 'local', `output:${taskId}:`);
  }
  async removeOrphanAttachments(): Promise<number> {
    const keep = new Set(
      this.tasks().flatMap((task) =>
        (task.attachments ?? []).map((item) => `attachment:${item.id}`),
      ),
    );
    const db = this.repository.db;
    const records = db
      .prepare("SELECT id FROM messages WHERE owner='local' AND substr(id,1,11)='attachment:'")
      .all();
    let removed = 0;
    for (const record of records)
      if (!keep.has(String(record.id))) {
        await this.repository.remove('messages', 'local', String(record.id));
        removed++;
      }
    return removed;
  }
  addGrant(key: string) {
    this.save('grants', createHash('sha256').update(key).digest('hex'), {
      allowed: true,
      description: key,
    });
  }
  close() {
    this.flush();
    return this.repository.close();
  }
}
