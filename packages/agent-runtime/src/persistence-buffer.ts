import type { AgentEvent, Task } from '@hikari/agent-core';

const presentationEvents = new Set([
  'agent.message.delta',
  'tool.stdout',
  'agent.thinking',
  'git.diff.updated',
  'agent.usage',
]);
export interface PendingTaskWrite<T> {
  task: Task;
  events: AgentEvent[];
  extra?: T;
}

/** Coalesce presentation updates; execution boundaries always flush synchronously. */
export class TaskWriteBuffer<T = never> {
  private pending = new Map<string, PendingTaskWrite<T>>();
  private timer?: ReturnType<typeof setTimeout>;
  private failure?: unknown;
  private failed = false;
  constructor(private write: (entries: PendingTaskWrite<T>[]) => void) {}
  update(task: Task, event?: AgentEvent, extra?: T) {
    if (this.failed) throw this.failure;
    const entry = this.pending.get(task.id) ?? { task, events: [] };
    entry.task = task;
    if (event) entry.events.push(event);
    if (extra !== undefined) entry.extra = extra;
    this.pending.set(task.id, entry);
    if (!event || !presentationEvents.has(event.type) || entry.events.length >= 2000)
      this.flush(task.id);
    else this.schedule();
  }
  private schedule() {
    if (this.timer || !this.pending.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.flush();
      } catch (error) {
        this.failure = error;
        this.failed = true;
      }
    }, 100);
    this.timer.unref();
  }
  flush(taskId?: string) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.failed) throw this.failure;
    const selected = [...this.pending].filter(([id]) => !taskId || id === taskId);
    try {
      if (selected.length) this.write(selected.map(([, entry]) => entry));
    } catch (error) {
      this.failure = error;
      this.failed = true;
      throw error;
    }
    for (const [id] of selected) this.pending.delete(id);
    this.schedule();
  }
}
