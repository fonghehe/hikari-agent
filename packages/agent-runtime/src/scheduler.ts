import { AgentError, type Task } from '@hikari/agent-core';
import type { AgentRunner } from './index';
interface Entry {
  task: Task;
  runner: Pick<AgentRunner, 'run' | 'cancel'>;
  resolve: () => void;
  reject: (error: unknown) => void;
}
export class TaskScheduler {
  private queue: Entry[] = [];
  private running = new Map<string, Entry>();
  private workspaces = new Set<string>();
  constructor(readonly maxParallel = 3) {
    if (!Number.isInteger(maxParallel) || maxParallel < 1)
      throw new Error('Invalid concurrency limit');
  }
  submit(task: Task, runner: Pick<AgentRunner, 'run' | 'cancel'>) {
    const root = task.worktree ?? task.workspace;
    if (this.workspaces.has(root))
      throw new AgentError('WORKSPACE_BUSY', 'Another task owns this workspace');
    this.workspaces.add(root);
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ task, runner, resolve, reject });
      this.drain();
    });
  }
  private drain() {
    while (this.running.size < this.maxParallel && this.queue.length) {
      const entry = this.queue.shift()!;
      this.running.set(entry.task.id, entry);
      void entry.runner
        .run()
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.running.delete(entry.task.id);
          this.workspaces.delete(entry.task.worktree ?? entry.task.workspace);
          this.drain();
        });
    }
  }
  cancel(id: string) {
    const index = this.queue.findIndex((entry) => entry.task.id === id);
    if (index >= 0) {
      const entry = this.queue.splice(index, 1)[0]!;
      entry.runner.cancel();
      void entry.runner
        .run()
        .then(entry.resolve, entry.reject)
        .finally(() => this.workspaces.delete(entry.task.worktree ?? entry.task.workspace));
    } else this.running.get(id)?.runner.cancel();
  }
  close() {
    for (const entry of [...this.queue, ...this.running.values()]) this.cancel(entry.task.id);
  }
  isWorkspaceBusy(root: string) {
    return this.workspaces.has(root);
  }
  get activeCount() {
    return this.running.size;
  }
  get queuedCount() {
    return this.queue.length;
  }
}
