import { it, expect } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { z } from '../packages/agent-core/node_modules/zod';
import {
  AgentRunner,
  ContextManager,
  EventBus,
  MemoryManager,
  TaskManager,
  ToolRegistry,
  parseCheckpoint,
  FileRunStore,
  searchMemory,
} from '../packages/agent-runtime/src';
import type { RunnerCheckpoint } from '../packages/agent-runtime/src';
import type { ModelProvider, ModelResponse, ModelRequest } from '../packages/agent-core/src';
function fixture(responses: ModelResponse[]) {
  const tasks = new TaskManager();
  const task = tasks.create('finish task', '/tmp');
  const events = new EventBus(task);
  const tools = new ToolRegistry();
  let saved: RunnerCheckpoint | undefined;
  const messages: ModelRequest[] = [];
  const provider: ModelProvider = {
    countTokens: (text) => Math.ceil(text.length / 4),
    async chat() {
      return responses.shift() ?? { text: 'done', toolCalls: [] };
    },
    async *stream(request) {
      messages.push(request);
      yield await this.chat(request);
    },
  };
  const deps = {
    tasks,
    events,
    tools,
    context: new ContextManager('system'),
    memory: new MemoryManager(),
    provider,
    permissions: { check: async () => true },
    checkpoints: {
      load: () => saved,
      save: (_id: string, checkpoint: RunnerCheckpoint) => {
        saved = structuredClone(checkpoint);
      },
    },
  };
  return { task, deps, tools, events, messages, saved: () => saved };
}
it('rejects completion when deterministic acceptance remains false', async () => {
  const f = fixture([]);
  const runner = new AgentRunner(f.task, {
    ...f.deps,
    verify: async () => ({
      passed: false,
      checks: [{ id: 'file', label: 'Required result', passed: false, detail: 'Missing result' }],
    }),
  });
  await runner.run();
  expect(f.task.status).toBe('failed');
  expect(f.task.runSummary?.stopReason).toBe('ACCEPTANCE_FAILED');
  expect(f.messages).toHaveLength(3);
});
it('reruns acceptance commands after the last mutation and rejects stale or failed checks', async () => {
  const f = fixture([
    { text: '', toolCalls: [{ id: 'change', name: 'mutate', input: {} }] },
    { text: 'done', toolCalls: [] },
    { text: 'verified', toolCalls: [] },
  ]);
  let calls = 0;
  f.task.runOptions = {
    mode: 'execute',
    maxSteps: 5,
    checks: [
      { id: 'test', label: 'Tests', kind: 'test', command: 'node', args: ['test'], cwd: '.' },
    ],
  };
  f.tools.register({
    name: 'mutate',
    description: 'test mutation',
    permission: 'filesystem.write',
    schema: z.object({}),
    async execute() {
      f.events.emit('file.changed', { path: 'changed.ts' });
      return { content: 'changed' };
    },
  });
  f.tools.register({
    name: 'run_tests',
    description: 'test executable',
    permission: 'shell.execute',
    schema: z.object({ command: z.string(), args: z.array(z.string()), cwd: z.string() }),
    async execute() {
      calls++;
      return { content: 'pass', metadata: { exitCode: 0 } };
    },
  });
  await new AgentRunner(f.task, f.deps).run();
  expect(calls).toBe(1);
  expect(f.task.status).toBe('completed');
  expect(f.task.runSummary?.verification?.passed).toBe(true);
});
it('persists a waiting question and restores it without replaying a pending mutation', async () => {
  const f = fixture([
    {
      text: '',
      toolCalls: [
        { id: 'ask', name: 'ask_user', input: { question: 'Which target?', choices: ['A', 'B'] } },
      ],
    },
  ]);
  const runner = new AgentRunner(f.task, {
    ...f.deps,
    requestUser: (_q, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
  });
  const running = runner.run();
  while (f.task.status !== 'waiting_input') await new Promise((resolve) => setTimeout(resolve, 1));
  runner.interrupt();
  await running;
  expect(f.task.status).toBe('interrupted');
  expect(f.saved()?.pending[0]?.state).toBe('running');
  expect(f.saved()?.done).toBe(false);
  const restored = new AgentRunner(f.task, {
    ...f.deps,
    tools: new ToolRegistry(),
    context: new ContextManager('system'),
    restored: f.saved(),
    requestUser: async (question) => {
      expect(question.question).toBe('Which target?');
      return 'B';
    },
  });
  await restored.run();
  expect(f.task.status).toBe('completed');
  expect(
    f.messages
      .at(-1)
      ?.messages.some((message) => message.role === 'tool' && message.content === 'B'),
  ).toBe(true);
  expect(f.saved()?.done).toBe(true);
});
it('applies mid-run instructions before allowing a final answer', async () => {
  const f = fixture([]);
  let turns = 0;
  f.deps.provider.stream = async function* (_request) {
    turns++;
    if (turns === 1) runner.enqueue('Include the revised target');
    yield { text: 'final', toolCalls: [] };
  };
  const runner = new AgentRunner(f.task, f.deps);
  await runner.run();
  expect(turns).toBe(2);
  expect(f.task.status).toBe('completed');
});
it('enforces a duration deadline even while the provider is blocked', async () => {
  const f = fixture([]);
  f.task.runOptions = { mode: 'execute', maxSteps: 5, maxDurationMs: 1000 };
  f.deps.provider.stream = async function* (request) {
    await new Promise((_resolve, reject) =>
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }),
    );
    yield { text: 'unreachable', toolCalls: [] };
  };
  await new AgentRunner(f.task, f.deps).run();
  expect(f.task.status).toBe('failed');
  expect(f.task.runSummary?.stopReason).toBe('TIME_BUDGET');
});
it('rejects corrupt checkpoint data', () => {
  expect(parseCheckpoint({ version: 1, messages: [{ role: 'root' }] })).toBeUndefined();
});
it('restores a waiting task from private disk storage and preserves project memory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-run-store-'));
  try {
    const f = fixture([
      {
        text: '',
        toolCalls: [
          { id: 'disk-question', name: 'ask_user', input: { question: 'Which target?' } },
        ],
      },
    ]);
    f.task.workspace = root;
    const store = new FileRunStore(root);
    store.saveTask(f.task);
    f.events.subscribe(() => store.saveTask(f.task));
    const runner = new AgentRunner(f.task, {
      ...f.deps,
      checkpoints: store,
      requestUser: (_question, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
    });
    const running = runner.run();
    while (f.task.status !== 'waiting_input')
      await new Promise((resolve) => setTimeout(resolve, 1));
    runner.interrupt();
    await running;
    const reopened = new FileRunStore(root);
    const task = reopened.task(f.task.id)!;
    expect(task.pendingQuestion?.question).toBe('Which target?');
    const events = new EventBus(task);
    events.subscribe(() => reopened.saveTask(task));
    await new AgentRunner(task, {
      ...f.deps,
      events,
      tools: new ToolRegistry(),
      context: new ContextManager('system'),
      checkpoints: reopened,
      restored: reopened.load(task.id),
      requestUser: async () => 'B',
    }).run();
    expect(reopened.task(task.id)?.status).toBe('completed');
    expect(reopened.load(task.id)?.done).toBe(true);
    if (process.platform !== 'win32')
      expect((await stat(path.join(root, '.agent', 'runs', task.id + '.json'))).mode & 0o777).toBe(
        0o600,
      );
    reopened.put(root, {
      id: task.agentId,
      title: '金额计算',
      content: '金额需要保留两位小数。',
      updatedAt: new Date().toISOString(),
    });
    expect(searchMemory(new FileRunStore(root).list(root), '金额计算应该怎么做')[0]?.title).toBe(
      '金额计算',
    );
    expect(new FileRunStore(root).list('different-project')).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('records usage on stream failure and prevents tools after a reported budget overrun', async () => {
  const f = fixture([
    { text: 'partial', toolCalls: [], usage: { inputTokens: 45, outputTokens: 7 } },
  ]);
  f.deps.provider.stream = async function* (request) {
    yield await this.chat(request);
    throw new Error('Stream disconnected');
  };
  await new AgentRunner(f.task, {
    ...f.deps,
    pricing: { inputPerMillion: 1, outputPerMillion: 2 },
  }).run();
  expect(f.task.status).toBe('failed');
  expect(f.task.runSummary?.inputTokens).toBe(45);
  expect(f.task.runSummary?.costUsd).toBeCloseTo(0.000059);
  const over = fixture([
    {
      text: '',
      toolCalls: [{ id: 'write', name: 'mutate', input: {} }],
      usage: { inputTokens: 1100, outputTokens: 1 },
    },
  ]);
  over.task.runOptions = { mode: 'execute', maxSteps: 5, maxTokens: 1000 };
  let mutations = 0;
  over.tools.register({
    name: 'mutate',
    description: 'mutation',
    permission: 'filesystem.write',
    schema: z.object({}),
    async execute() {
      mutations++;
      return { content: 'done' };
    },
  });
  await new AgentRunner(over.task, over.deps).run();
  expect(over.task.runSummary?.stopReason).toBe('TOKEN_BUDGET');
  expect(mutations).toBe(0);
});
it('does not replay uncertain side effects or accept stale test evidence after recovery', async () => {
  const f = fixture([]);
  let sideEffects = 0;
  f.tools.register({
    name: 'write_file',
    description: 'mutation',
    permission: 'filesystem.write',
    schema: z.object({}),
    async execute() {
      sideEffects++;
      return { content: 'changed' };
    },
  });
  const checkpoint: RunnerCheckpoint = {
    version: 1,
    messages: [
      { role: 'user', content: 'finish' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'write', name: 'write_file', input: {} }],
      },
    ],
    memory: [],
    summary: {
      modelSteps: 1,
      toolCalls: 1,
      toolFailures: 0,
      durationMs: 0,
      filesChanged: [],
      tests: [],
    },
    revision: 0,
    testedRevision: {},
    pending: [{ call: { id: 'write', name: 'write_file', input: {} }, state: 'running' }],
    queued: [],
    updatedAt: new Date().toISOString(),
    done: false,
  };
  await new AgentRunner(f.task, {
    ...f.deps,
    restored: checkpoint,
    requestUser: async () => 'Inspect and continue',
  }).run();
  expect(sideEffects).toBe(0);
  expect(f.task.runSummary?.stopReason).toBe('ACCEPTANCE_FAILED');
  const repeated = fixture([]);
  await new AgentRunner(repeated.task, {
    ...repeated.deps,
    restored: {
      ...checkpoint,
      pending: checkpoint.pending.map((entry) => ({ ...entry, state: 'done' })),
      needsVerification: true,
      revision: 1,
    },
  }).run();
  expect(repeated.task.runSummary?.stopReason).toBe('ACCEPTANCE_FAILED');
});
