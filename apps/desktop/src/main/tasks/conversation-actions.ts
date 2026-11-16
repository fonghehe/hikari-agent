import { randomUUID } from 'node:crypto';
import type { Task } from '@hikari/agent-core';

/** Copy conversation content, never live execution state or pending permissions. */
export function copyConversation(source: Task, target: Task, title: string): Task {
  target.title = title;
  target.status = 'completed';
  target.parentTaskId = source.parentTaskId;
  target.demo = source.demo;
  target.chat = source.chat;
  target.imported = source.imported;
  target.attachments = structuredClone(source.attachments);
  target.modelProfileId = source.modelProfileId;
  target.modelIdentity = structuredClone(source.modelIdentity);
  target.runOptions = structuredClone(source.runOptions);
  target.plan = structuredClone(source.plan);
  target.runSummary = structuredClone(source.runSummary);
  target.worktree = source.worktree;
  target.events = source.events
    .filter((event) => ['agent.completed', 'agent.message', 'agent.thinking'].includes(event.type))
    .map((event) => ({
      ...structuredClone(event),
      id: randomUUID(),
      taskId: target.id,
      agentId: target.agentId,
    }));
  return target;
}

export function conversationMarkdown(task: Task, lookup: (id: string) => Task): string {
  const turns: Task[] = [];
  const seen = new Set<string>();
  let current: Task | undefined = task;
  while (current && !seen.has(current.id) && turns.length < 2000) {
    seen.add(current.id);
    turns.unshift(current);
    current = current.parentTaskId ? lookup(current.parentTaskId) : undefined;
  }
  return `# ${task.title}\n\n${turns.map((turn) => `${turn.prompt}\n\n${conversationAnswer(turn)}`).join('\n\n---\n\n')}`;
}

export function conversationAnswer(task: Task): string {
  const final = task.events
    .slice()
    .reverse()
    .find((event) => event.type === 'agent.completed');
  return typeof final?.data.text === 'string' ? final.data.text : '';
}
