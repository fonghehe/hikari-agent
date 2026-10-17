import { describe, expect, it } from 'vitest';
import { TaskManager } from '../packages/agent-runtime/src';
import {
  conversationMarkdown,
  copyConversation,
} from '../apps/desktop/src/main/conversation-actions';

describe('saved conversation actions', () => {
  it('forks content with new identities and independent data without live permissions or checkpoints', () => {
    const tasks = new TaskManager();
    const original = tasks.create('Question', '/project');
    original.status = 'completed';
    original.navigation = { pinned: true, unread: true, section: 'Work' };
    original.archived = true;
    original.resumable = true;
    original.events = [
      {
        id: 'answer',
        taskId: original.id,
        agentId: original.agentId,
        timestamp: original.updatedAt,
        type: 'agent.completed',
        data: { text: 'Answer' },
      },
      {
        id: 'private',
        taskId: original.id,
        agentId: original.agentId,
        timestamp: original.updatedAt,
        type: 'permission.requested',
        data: { command: 'private' },
      },
    ];
    const fork = copyConversation(
      original,
      tasks.create(original.prompt, original.workspace),
      'Fork',
    );
    expect(fork.id).not.toBe(original.id);
    expect(fork.agentId).not.toBe(original.agentId);
    expect(fork.events).toHaveLength(1);
    expect(fork.events[0]).toMatchObject({
      taskId: fork.id,
      agentId: fork.agentId,
      data: { text: 'Answer' },
    });
    expect(fork.events[0]!.id).not.toBe('answer');
    expect(fork).toMatchObject({ status: 'completed', title: 'Fork', workspace: '/project' });
    expect(fork.archived).toBeUndefined();
    expect(fork.resumable).toBeUndefined();
    expect(fork.navigation).toBeUndefined();
    fork.events[0]!.data.text = 'Changed';
    expect(original.events[0]!.data.text).toBe('Answer');
  });

  it('copies ordered conversation turns without tool outputs and terminates malformed cycles', () => {
    const tasks = new TaskManager();
    const first = tasks.create('First question', '/project');
    const second = tasks.create('Follow up', '/project');
    second.parentTaskId = first.id;
    first.events = [
      {
        id: 'answer',
        taskId: first.id,
        agentId: first.agentId,
        timestamp: first.updatedAt,
        type: 'agent.completed',
        data: { text: 'First answer' },
      },
    ];
    second.events = [
      {
        id: 'private',
        taskId: second.id,
        agentId: second.agentId,
        timestamp: second.updatedAt,
        type: 'tool.stdout',
        data: { text: 'PRIVATE OUTPUT' },
      },
    ];
    const markdown = conversationMarkdown(second, (id) => tasks.get(id));
    expect(markdown).toContain('First question\n\nFirst answer\n\n---\n\nFollow up');
    expect(markdown).not.toContain('PRIVATE OUTPUT');
    first.parentTaskId = second.id;
    expect(conversationMarkdown(second, (id) => tasks.get(id)).length).toBeLessThan(200);
  });
});
