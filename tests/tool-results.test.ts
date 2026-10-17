import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from '../packages/agent-core/node_modules/zod';
import {
  AgentRunner,
  ContextManager,
  EventBus,
  FileRunStore,
  MemoryManager,
  TaskManager,
  ToolObservations,
  ToolRegistry,
  observationLimit,
} from '../packages/agent-runtime/src';
import type { ModelProvider, ToolContext } from '../packages/agent-core/src';
import { LocalPersistence } from '../apps/desktop/src/main/persistence';

function reader(observations: ToolObservations) {
  const tools = new ToolRegistry();
  observations.register(tools);
  const tool = tools.get('read_tool_result');
  return async (input: unknown) => {
    const result = await tool.execute(tool.parse(input), {} as ToolContext);
    expect(result.content.length).toBeLessThanOrEqual(observationLimit);
    return JSON.parse(result.content) as { content: string; nextOffset: number | null };
  };
}

it('preserves valid previews and reconstructs escaped large results from bounded pages', async () => {
  const observations = new ToolObservations(randomUUID());
  const source = JSON.stringify({
    data: '\u0000\n"\\中文'.repeat(10000),
    final: 'important final error',
  });
  const previewText = observations.capture(source);
  expect(previewText.length).toBeLessThanOrEqual(observationLimit);
  const preview = JSON.parse(previewText);
  expect(preview).toMatchObject({ truncated: true, totalChars: source.length });
  expect(preview.tail).toContain('important final error');
  const read = reader(observations);
  let offset: number | null = 0;
  let reconstructed = '';
  while (offset !== null) {
    const page = await read({ resultId: preview.resultId, offset, limit: 12000 });
    reconstructed += page.content;
    offset = page.nextOffset;
  }
  expect(reconstructed).toBe(source);
  await expect(read({ resultId: preview.resultId, offset: source.length + 1 })).rejects.toThrow(
    'Offset',
  );
});

it('restores full results from private CLI storage and isolates tasks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-results-'));
  try {
    const taskId = randomUUID();
    const source = 'x'.repeat(40000) + 'tail';
    const preview = JSON.parse(
      new ToolObservations(taskId, new FileRunStore(root)).capture(source),
    );
    const read = reader(new ToolObservations(taskId, new FileRunStore(root)));
    expect((await read({ resultId: preview.resultId, offset: 40000 })).content).toBe('tail');
    const other = reader(new ToolObservations(randomUUID(), new FileRunStore(root)));
    await expect(other({ resultId: preview.resultId })).rejects.toThrow('No saved result');
    if (process.platform !== 'win32')
      expect(
        (await stat(path.join(root, '.agent', 'runs', `output-${taskId}-${preview.resultId}.json`)))
          .mode & 0o777,
      ).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('stores desktop results outside checkpoints and removes only the deleted task outputs', async () => {
  const store = new LocalPersistence(':memory:');
  try {
    const first = randomUUID(),
      second = randomUUID();
    const source = 'x'.repeat(30000);
    const one = JSON.parse(new ToolObservations(first, store.checkpoints).capture(source));
    const two = JSON.parse(new ToolObservations(second, store.checkpoints).capture(source));
    expect(
      (await reader(new ToolObservations(first, store.checkpoints))({ resultId: one.resultId }))
        .content,
    ).toBe(source.slice(0, 8000));
    store.removeTaskOutputs(first);
    expect(store.checkpoints.loadOutput(first, one.resultId)).toBeUndefined();
    expect(store.checkpoints.loadOutput(second, two.resultId)).toBe(source);
  } finally {
    await store.close();
  }
});

it('lets the model read the tail of a long result without re-executing its source tool', async () => {
  const tasks = new TaskManager(),
    task = tasks.create('inspect failure', '/fixture');
  const tools = new ToolRegistry();
  let executions = 0,
    turns = 0;
  tools.register({
    name: 'long_log',
    description: 'fixture',
    permission: 'filesystem.read',
    schema: z.object({}),
    execute: async () => {
      executions++;
      return { content: JSON.stringify({ log: 'x'.repeat(40000), error: 'tail diagnostic' }) };
    },
  });
  const provider: ModelProvider = {
    countTokens: (text) => Math.ceil(text.length / 4),
    chat: async () => ({ text: 'unused', toolCalls: [] }),
    async *stream(request) {
      turns++;
      if (turns === 1)
        yield { text: '', toolCalls: [{ id: 'source', name: 'long_log', input: {} }] };
      else if (turns === 2) {
        const preview = JSON.parse(request.messages.at(-1)!.content);
        expect(preview.truncated).toBe(true);
        yield {
          text: '',
          toolCalls: [
            {
              id: 'page',
              name: 'read_tool_result',
              input: { resultId: preview.resultId, offset: preview.totalChars - 100 },
            },
          ],
        };
      } else {
        expect(JSON.parse(request.messages.at(-1)!.content).content).toContain('tail diagnostic');
        yield { text: 'verified tail', toolCalls: [] };
      }
    },
  };
  await new AgentRunner(task, {
    tasks,
    tools,
    provider,
    events: new EventBus(task),
    context: new ContextManager('system'),
    memory: new MemoryManager(),
    permissions: { check: async () => true },
  }).run();
  expect(task.status).toBe('completed');
  expect(executions).toBe(1);
  expect(task.runSummary?.toolCalls).toBe(2);
});

it('resumes a runner with saved large results after reopening the desktop database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-result-resume-'));
  const filename = path.join(root, 'state.sqlite');
  let store = new LocalPersistence(filename);
  try {
    const tasks = new TaskManager(),
      task = tasks.create('inspect result', root);
    const tools = new ToolRegistry();
    tools.register({
      name: 'long_log',
      description: 'fixture',
      permission: 'filesystem.read',
      schema: z.object({}),
      execute: async () => ({ content: 'x'.repeat(40000) + 'saved tail' }),
    });
    const events = new EventBus(task);
    events.subscribe((event) => store.task(task, event));
    let turn = 0;
    const provider: ModelProvider = {
      countTokens: (text) => Math.ceil(text.length / 4),
      chat: async () => ({ text: '', toolCalls: [] }),
      async *stream() {
        if (++turn === 1)
          yield { text: '', toolCalls: [{ id: 'log', name: 'long_log', input: {} }] };
        else {
          runner.interrupt();
          yield { text: '', toolCalls: [] };
        }
      },
    };
    const runner = new AgentRunner(task, {
      tasks,
      tools,
      events,
      provider,
      context: new ContextManager('system'),
      memory: new MemoryManager(),
      permissions: { check: async () => true },
      checkpoints: store.checkpoints,
    });
    await runner.run();
    expect(task.status).toBe('interrupted');
    await store.close();
    store = new LocalPersistence(filename);
    const savedTask = store.tasks()[0]!;
    const restored = store.checkpoints.load(task.id)!;
    const preview = JSON.parse(
      restored.messages.find((message) => message.toolCallId === 'log')!.content,
    );
    turn = 0;
    provider.stream = async function* (request) {
      if (++turn === 1)
        yield {
          text: '',
          toolCalls: [
            {
              id: 'page',
              name: 'read_tool_result',
              input: { resultId: preview.resultId, offset: 40000 },
            },
          ],
        };
      else {
        expect(JSON.parse(request.messages.at(-1)!.content).content).toBe('saved tail');
        yield { text: 'restored result verified', toolCalls: [] };
      }
    };
    await new AgentRunner(savedTask, {
      tasks,
      tools: new ToolRegistry(),
      events: new EventBus(savedTask),
      provider,
      context: new ContextManager('system'),
      memory: new MemoryManager(),
      permissions: { check: async () => true },
      checkpoints: store.checkpoints,
      restored,
    }).run();
    expect(savedTask.status).toBe('completed');
    expect(savedTask.runSummary?.toolCalls).toBe(2);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
