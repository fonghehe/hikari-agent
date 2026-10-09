import { it, expect } from 'vitest';
import { z } from '../packages/agent-core/node_modules/zod';
import {
  AgentRunner,
  ContextManager,
  EventBus,
  MemoryManager,
  TaskManager,
  ToolRegistry,
} from '../packages/agent-runtime/src';
import type { ModelProvider, ModelResponse, PermissionManager } from '../packages/agent-core/src';
function setup(
  responses: ModelResponse[],
  permissions: PermissionManager = { check: async () => true },
) {
  const tasks = new TaskManager();
  const task = tasks.create('test', '/tmp');
  const events = new EventBus(task);
  const tools = new ToolRegistry();
  const seen: string[] = [];
  tools.register({
    name: 'echo',
    description: 'echo',
    schema: z.object({ text: z.string() }),
    permission: 'filesystem.read',
    execute: async (input) => {
      seen.push(input.text);
      return { content: input.text };
    },
  });
  const provider: ModelProvider = {
    chat: async () => responses.shift() ?? { text: 'done', toolCalls: [] },
    async *stream() {
      yield await this.chat({ messages: [], tools: [], signal: new AbortController().signal });
    },
    countTokens: (t) => t.length,
  };
  const runner = new AgentRunner(task, {
    provider,
    tools,
    context: new ContextManager('system'),
    permissions,
    events,
    memory: new MemoryManager(),
    tasks,
  });
  return { task, runner, seen, events };
}
it('loops through observations to a final response', async () => {
  const s = setup([{ text: '', toolCalls: [{ id: '1', name: 'echo', input: { text: 'hello' } }] }]);
  await s.runner.run();
  expect(s.task.status).toBe('completed');
  expect(s.seen).toEqual(['hello']);
  expect(s.task.events.some((e) => e.type === 'tool.completed')).toBe(true);
});
it('denied tools never execute and the model receives an observation', async () => {
  const s = setup([{ text: '', toolCalls: [{ id: '1', name: 'echo', input: { text: 'bad' } }] }], {
    check: async () => false,
  });
  await s.runner.run();
  expect(s.seen).toEqual([]);
  expect(s.task.status).toBe('completed');
  expect(s.task.events.some((e) => e.type === 'tool.failed')).toBe(true);
});
it('cancel wakes a paused runner', async () => {
  const s = setup([]);
  s.runner.pause();
  const run = s.runner.run();
  await new Promise((r) => setTimeout(r, 5));
  expect(s.task.status).toBe('paused');
  s.runner.cancel();
  await run;
  expect(s.task.status).toBe('cancelled');
});
it('redacts secrets from event subscribers and history', () => {
  const s = setup([]);
  s.events.emit('test', { apiKey: 'private', output: 'token=abcdef' });
  expect(JSON.stringify(s.task.events)).not.toContain('abcdef');
  expect(JSON.stringify(s.task.events)).not.toContain('private');
});

it('keeps recent attached images when newer browser screenshots enter context', () => {
  const context = new ContextManager('system', 64000);
  context.add({
    role: 'user',
    content: 'Old source',
    images: [{ mimeType: 'image/png', data: 'old' }],
  });
  context.add({
    role: 'user',
    content: 'Analyze uploaded image',
    images: [{ mimeType: 'image/png', data: 'upload' }],
    references: [{ name: 'design.png', kind: 'image' }],
  });
  context.add({
    role: 'tool',
    content: 'Browser screenshot',
    toolCallId: 'screenshot',
    images: [{ mimeType: 'image/jpeg', data: 'browser' }],
  });
  const messages = context.build(
    { countTokens: (text) => text.length / 4 } as ModelProvider,
    new MemoryManager(),
  );
  expect(messages.flatMap((message) => message.images?.map((image) => image.data) ?? [])).toEqual([
    'upload',
    'browser',
  ]);
  expect(messages[1]?.content).toContain('image data omitted');
});
