import { randomUUID } from 'node:crypto';
import { AgentError, type Task } from '@hikari/agent-core';

export class TaskManager {
  private tasks = new Map<string, Task>();
  remove(id: string) {
    this.tasks.delete(id);
  }
  restore(task: Task) {
    this.tasks.set(task.id, task);
  }
  create(prompt: string, workspace: string, id: string = randomUUID()): Task {
    if (this.tasks.has(id)) throw new AgentError('DUPLICATE_TASK', id);
    const now = new Date().toISOString();
    const task: Task = {
      id,
      agentId: randomUUID(),
      title: prompt.slice(0, 70),
      prompt,
      workspace,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    this.tasks.set(task.id, task);
    return task;
  }
  get(id: string) {
    const task = this.tasks.get(id);
    if (!task) throw new AgentError('UNKNOWN_TASK', id);
    return task;
  }
  list() {
    return [...this.tasks.values()];
  }
}
