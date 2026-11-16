import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runOptionsSchema, type ModelProvider } from '../../packages/agent-core/src/index';
import {
  AgentRunner,
  ContextManager,
  EventBus,
  FileRunStore,
  MemoryManager,
  TaskManager,
  ToolRegistry,
} from '../../packages/agent-runtime/src/index';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(['succeeded', 'not-applied', 'unknown'] as const)(
  'reconciles %s external outcomes without blindly repeating an uncertain action',
  async (outcome) => {
    const root = await mkdtemp(path.join(tmpdir(), 'hikari-operation-'));
    roots.push(root);
    const tasks = new TaskManager();
    const task = tasks.create('Create exactly one external issue', root);
    task.runOptions = runOptionsSchema.parse({ requireTests: false, maxSteps: 6 });
    const store = new FileRunStore(root);
    const events = new EventBus(task);
    events.subscribe(() => store.saveTask(task), { critical: true });
    let writes = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'create_issue',
      description: 'External mutation',
      permission: 'shell.network',
      schema: z.object({ title: z.string() }),
      recovery: {
        effect: 'side-effect',
        reconcile: async () => ({ state: outcome, detail: `External lookup: ${outcome}` }),
      },
      execute: async () => {
        if (outcome === 'succeeded') writes++;
        first.interrupt();
        return { content: 'Response lost after sending request' };
      },
    });
    const provider = (
      replies: { text: string; toolCalls: { id: string; name: string; input: unknown }[] }[],
    ): ModelProvider => ({
      countTokens: () => 1,
      chat: async () => replies.shift() ?? { text: 'Done', toolCalls: [] },
      async *stream(request) {
        yield await this.chat(request);
      },
    });
    const dependencies = () => ({
      tasks,
      events,
      tools,
      memory: new MemoryManager(),
      context: new ContextManager('Inspect actual effects.'),
      permissions: { check: async () => true },
      checkpoints: store,
    });
    const first = new AgentRunner(task, {
      ...dependencies(),
      provider: provider([
        {
          text: '',
          toolCalls: [{ id: 'original', name: 'create_issue', input: { title: 'one' } }],
        },
      ]),
    });
    await first.run();
    const saved = store.load(task.id)!;
    expect(saved.operations?.[0]?.state).toBe('unknown');
    expect(saved.pending[0]?.state).toBe('running');
    store.close();
    const reopened = new FileRunStore(root);
    const restored = reopened.load(task.id)!;
    const secondTools = new ToolRegistry();
    secondTools.register({
      name: 'create_issue',
      description: 'External mutation',
      permission: 'shell.network',
      schema: z.object({ title: z.string() }),
      recovery: {
        effect: 'side-effect',
        reconcile: async () => ({ state: outcome, detail: `External lookup: ${outcome}` }),
      },
      execute: async () => {
        writes++;
        return { content: 'Created once' };
      },
    });
    let questions = 0;
    await new AgentRunner(task, {
      ...dependencies(),
      tools: secondTools,
      checkpoints: reopened,
      restored,
      provider: provider([
        { text: '', toolCalls: [{ id: 'repeat', name: 'create_issue', input: { title: 'one' } }] },
      ]),
      requestUser: async () => {
        questions++;
        return 'Inspect and continue';
      },
    }).run();
    expect(writes).toBe(outcome === 'unknown' ? 0 : 1);
    expect(questions).toBe(outcome === 'unknown' ? 1 : 0);
    const errors = task.events
      .filter((event) => event.type === 'tool.failed')
      .map((event) => String(event.data.error));
    if (outcome !== 'not-applied')
      expect(errors.some((text) => /unknown outcome|already succeeded/.test(text))).toBe(true);
    expect(reopened.load(task.id)?.operations?.[0]).toMatchObject({
      state: outcome,
      recovered: true,
    });
    reopened.close();
  },
);
