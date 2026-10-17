import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { z } from '../packages/agent-core/node_modules/zod';
import {
  AgentRunner,
  AutomationService,
  StateStore,
  nextAutomation,
  SubagentTeam,
  TaskManager,
  ToolRegistry,
  EventBus,
  ContextManager,
  MemoryManager,
} from '../packages/agent-runtime/src';
import { HookLifecycle } from '../packages/tools/src/hooks';
import { FileChangeService } from '../packages/tools/src';
import { LogicalSandboxProvider } from '../packages/sandbox/src';
import type { ModelProvider, ModelResponse, Task, ToolContext } from '../packages/agent-core/src';

const directories: string[] = [];
async function temp() {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-platform-'));
  directories.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function provider(responses: ModelResponse[]): ModelProvider {
  return {
    countTokens: (text) => Math.ceil(text.length / 4),
    chat: async () => responses.shift() ?? { text: 'Finished', toolCalls: [] },
    async *stream(request) {
      yield await this.chat(request);
    },
  };
}
const context = (task: Task, events: EventBus): ToolContext => ({
  taskId: task.id,
  workspace: task.workspace,
  events,
  signal: new AbortController().signal,
});

it('persists schedules, runs once, prevents overlapping ticks, and only notifies on meaningful changes', async () => {
  const root = await temp();
  const service = new AutomationService(new StateStore(root));
  const now = Date.parse('2026-10-20T00:00:00Z');
  service.create(
    {
      name: 'poll',
      prompt: 'Check changes',
      cadence: { kind: 'interval', minutes: 1 },
      isolated: false,
    },
    now,
  );
  let finish!: () => void;
  let calls = 0;
  let notices = 0;
  const run = async () => {
    calls++;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { taskId: 'fixture', status: 'completed', result: 'No changes' };
  };
  const tick = service.tick(run, () => notices++, now + 60000);
  await Promise.resolve();
  await service.tick(run, () => notices++, now + 60000);
  expect(calls).toBe(1);
  finish();
  await tick;
  const restored = new AutomationService(new StateStore(root));
  await restored.tick(
    async () => ({ taskId: 'next', status: 'completed', result: 'No changes' }),
    () => notices++,
    now + 120000,
  );
  expect(notices).toBe(1);
  expect(restored.list()[0]?.last?.taskId).toBe('next');
});
it('recovers interrupted schedules without replaying side effects and respects one-shot execution', async () => {
  const state = new StateStore(await temp());
  const service = new AutomationService(state);
  const now = Date.now();
  const item = service.create(
    {
      name: 'once',
      prompt: 'Inspect',
      cadence: { kind: 'once', at: new Date(now + 1000).toISOString() },
    },
    now,
  );
  state.set('automations', [{ ...item, running: true }]);
  service.recover();
  expect(service.list()[0]).toMatchObject({
    enabled: false,
    running: false,
    last: { status: 'interrupted' },
  });
  let ran = false;
  await service.tick(
    async () => {
      ran = true;
      return { taskId: '', status: 'completed', result: '' };
    },
    () => {},
    now + 2000,
  );
  expect(ran).toBe(false);
  const once = new AutomationService(new StateStore(await temp()));
  once.create(
    {
      name: 'once',
      prompt: 'Inspect',
      cadence: { kind: 'once', at: new Date(now + 1000).toISOString() },
    },
    now,
  );
  let count = 0;
  const run = async () => ({ taskId: String(++count), status: 'completed', result: 'Done' });
  await once.tick(run, () => {}, now + 2000);
  await once.tick(run, () => {}, now + 3000);
  expect(count).toBe(1);
});
it('calculates cron occurrences in the configured timezone and rejects invalid fields', () => {
  expect(
    nextAutomation(
      { kind: 'cron', expression: '5 9 * * *', timezone: 'Asia/Shanghai' },
      Date.parse('2026-10-20T01:04:00Z'),
    ),
  ).toBe('2026-10-20T01:05:00.000Z');
  expect(
    nextAutomation(
      { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' },
      Date.parse('2026-10-20T00:01:00Z'),
    ),
  ).toBe('2026-10-20T00:05:00.000Z');
  expect(() =>
    nextAutomation({ kind: 'cron', expression: '0,99 * * * *', timezone: 'UTC' }, 0),
  ).toThrow();
});
it('protects state storage from symlinks and serializes cross-process updates', async () => {
  const root = await temp();
  const target = await temp();
  await symlink(target, path.join(root, '.agent'));
  expect(() => new StateStore(root)).toThrow('real directories');
  const store = new StateStore(target);
  store.set('counter', 1);
  store.transaction('counter', () => {
    expect(() => store.transaction('counter', () => {})).toThrow('locked');
    store.set('counter', 2);
  });
  expect(store.get('counter')).toBe(2);
});
it('enforces hook approval, supplies bounded stdin, and records hook edits', async () => {
  const root = await temp();
  const store = new StateStore(root);
  void store;
  await writeFile(
    path.join(root, '.agent/hooks.json'),
    JSON.stringify([
      {
        id: 'format',
        event: 'PostToolUse',
        command: process.execPath,
        args: ['-e', "require('fs').writeFileSync('formatted.txt','ok')"],
      },
    ]),
  );
  const task = new TaskManager().create('fixture', root);
  const events = new EventBus(task);
  const changes = new FileChangeService(root, events);
  const denied = await new HookLifecycle(
    task,
    events,
    { check: async () => false },
    new LogicalSandboxProvider(),
    changes,
  ).load(root);
  await expect(denied.dispatch('PostToolUse', new AbortController().signal)).rejects.toThrow(
    'Hook denied',
  );
  await expect(readFile(path.join(root, 'formatted.txt'))).rejects.toThrow();
  const approved = await new HookLifecycle(
    task,
    events,
    { check: async () => true },
    new LogicalSandboxProvider(),
    changes,
  ).load(root);
  await approved.dispatch('PostToolUse', new AbortController().signal);
  expect(changes.history[0]).toMatchObject({ path: 'formatted.txt', after: 'ok' });
});
it('blocks operations when a pre-tool hook fails', async () => {
  const root = await temp();
  new StateStore(root);
  await writeFile(
    path.join(root, '.agent/hooks.json'),
    JSON.stringify([
      {
        id: 'block',
        event: 'PreToolUse',
        command: process.execPath,
        args: ['-e', 'process.exit(2)'],
      },
    ]),
  );
  const tasks = new TaskManager();
  const task = tasks.create('fixture', root);
  const events = new EventBus(task);
  const tools = new ToolRegistry();
  let called = false;
  tools.register({
    name: 'write_file',
    description: 'fixture',
    permission: 'filesystem.write',
    schema: z.object({}),
    execute: async () => {
      called = true;
      return { content: 'written' };
    },
  });
  const lifecycle = await new HookLifecycle(
    task,
    events,
    { check: async () => true },
    new LogicalSandboxProvider(),
    new FileChangeService(root, events),
  ).load(root);
  const runner = new AgentRunner(task, {
    tasks,
    tools,
    events,
    lifecycle,
    permissions: { check: async () => true },
    provider: provider([{ text: '', toolCalls: [{ id: 'write', name: 'write_file', input: {} }] }]),
    context: new ContextManager('test'),
    memory: new MemoryManager(),
  });
  await runner.run();
  expect(called).toBe(false);
  expect(
    task.events.some(
      (event) => event.type === 'tool.failed' && String(event.data.error).includes('blocked'),
    ),
  ).toBe(true);
});
it('runs delegated investigations with isolated context and no write tools', async () => {
  const tasks = new TaskManager();
  const parent = tasks.create('main', await temp());
  const events = new EventBus(parent);
  const tools = new ToolRegistry();
  let writes = 0;
  tools.register({
    name: 'write_file',
    description: 'write',
    permission: 'filesystem.write',
    schema: z.object({}),
    execute: async () => {
      writes++;
      return { content: '' };
    },
  });
  const team = new SubagentTeam({
    parent,
    tasks,
    registry: tools,
    events,
    provider: provider([
      { text: '', toolCalls: [{ id: 'forged', name: 'write_file', input: {} }] },
    ]),
    permissions: { check: async () => true },
  });
  team.register();
  const tool = tools.get('spawn_agent');
  const spawned = JSON.parse(
    (await tool.execute(tool.parse({ prompt: 'Read only' }), context(parent, events))).content,
  );
  const wait = tools.get('wait_agent');
  const result = JSON.parse(
    (await wait.execute({ id: spawned.id }, context(parent, events))).content,
  );
  expect(writes).toBe(0);
  expect(result.status).toBe('completed');
  const child = tasks.get(spawned.id);
  expect(child.parentTaskId).toBe(parent.id);
  expect(child.events.some((event) => event.type === 'tool.failed')).toBe(true);
  await team.close();
});
it('reserves delegated budgets and rejects delegation when the parent allowance is exhausted', async () => {
  const tasks = new TaskManager();
  const parent = tasks.create('main', await temp());
  parent.runOptions = { mode: 'execute', maxSteps: 30, maxTokens: 1000 };
  const tools = new ToolRegistry();
  const events = new EventBus(parent);
  const team = new SubagentTeam({
    parent,
    tasks,
    registry: tools,
    events,
    provider: provider([]),
    permissions: { check: async () => true },
  });
  team.register();
  const tool = tools.get('spawn_agent');
  await expect(
    tool.execute(tool.parse({ prompt: 'Inspect' }), context(parent, events)),
  ).rejects.toThrow('Insufficient parent budget');
});
it('continues a persistent goal across turns and requires an explicit completion report', async () => {
  const tasks = new TaskManager();
  const task = tasks.create('long task', await temp());
  task.runOptions = {
    mode: 'execute',
    maxSteps: 2,
    goal: { objective: 'Verify the requested outcome', maxContinuations: 2 },
  };
  const runner = new AgentRunner(task, {
    tasks,
    events: new EventBus(task),
    tools: new ToolRegistry(),
    permissions: { check: async () => true },
    provider: provider([
      { text: 'More investigation required', toolCalls: [] },
      {
        text: '',
        toolCalls: [
          {
            id: 'goal',
            name: 'update_goal',
            input: {
              status: 'complete',
              evidence: 'Inspected the fixture and verified the requested outcome.',
            },
          },
        ],
      },
    ]),
    context: new ContextManager('test'),
    memory: new MemoryManager(),
  });
  await runner.run();
  expect(task.status).toBe('completed');
  expect(task.goal).toMatchObject({ status: 'complete', continuations: 1 });
});
it('bounds goal continuations rather than looping forever on empty final answers', async () => {
  const tasks = new TaskManager();
  const task = tasks.create('long task', await temp());
  task.runOptions = {
    mode: 'execute',
    maxSteps: 5,
    goal: { objective: 'Unfinished', maxContinuations: 1 },
  };
  await new AgentRunner(task, {
    tasks,
    events: new EventBus(task),
    tools: new ToolRegistry(),
    permissions: { check: async () => true },
    provider: provider([]),
    context: new ContextManager('test'),
    memory: new MemoryManager(),
  }).run();
  expect(task.runSummary?.stopReason).toBe('GOAL_CONTINUATION_LIMIT');
  expect(task.goal?.status).toBe('active');
});
it('keeps an unverified goal unfinished even when the model reports completion', async () => {
  const tasks = new TaskManager();
  const task = tasks.create('Verify outcome', await temp());
  task.runOptions = {
    mode: 'execute',
    maxSteps: 10,
    goal: { objective: 'Pass the configured acceptance', maxContinuations: 2 },
  };
  await new AgentRunner(task, {
    tasks,
    events: new EventBus(task),
    tools: new ToolRegistry(),
    permissions: { check: async () => true },
    provider: provider([
      {
        text: '',
        toolCalls: [
          {
            id: 'goal',
            name: 'update_goal',
            input: {
              status: 'complete',
              evidence: 'The model reports that the requested work is complete.',
            },
          },
        ],
      },
    ]),
    context: new ContextManager('test'),
    memory: new MemoryManager(),
    verify: async () => ({
      passed: false,
      checks: [
        {
          id: 'acceptance',
          label: 'Fixture acceptance',
          passed: false,
          detail: 'The current output is still incorrect',
        },
      ],
    }),
  }).run();
  expect(task.runSummary?.stopReason).toBe('ACCEPTANCE_FAILED');
  expect(task.goal?.status).toBe('active');
});
it('requires goal completion before handing implementation to independent review', async () => {
  const tasks = new TaskManager();
  const task = tasks.create('Implement and review', await temp());
  task.runOptions = {
    mode: 'execute',
    workflow: 'development',
    maxSteps: 10,
    goal: { objective: 'Reach the requested outcome and review it', maxContinuations: 2 },
  };
  const tools = new ToolRegistry();
  tools.register({
    name: 'read_file',
    description: 'Inspect fixture',
    permission: 'filesystem.read',
    schema: z.object({}),
    execute: async () => ({ content: 'Actual inspected fixture source' }),
  });
  const call = (name: string, input: unknown): ModelResponse => ({
    text: '',
    toolCalls: [{ id: name + Math.random(), name, input }],
  });
  const responses = [
    call('handoff_stage', {
      report:
        'Inspected the repository and identified a focused implementation with concrete file evidence.',
    }),
    call('handoff_stage', {
      report:
        'Implement the bounded change, verify the requested outcome and then request independent review.',
    }),
    { text: 'The persistent objective still needs a final check.', toolCalls: [] },
    call('update_goal', {
      status: 'complete',
      evidence: 'The requested outcome was inspected and its acceptance evidence recorded.',
    }),
    { text: 'The implementation is ready for review.', toolCalls: [] },
    call('read_file', {}),
    call('submit_review', {
      passed: true,
      findings: [],
      evidence:
        'Independently inspected the current fixture source and found no actionable regression.',
    }),
  ];
  await new AgentRunner(task, {
    tasks,
    tools,
    events: new EventBus(task),
    permissions: { check: async () => true },
    provider: provider(responses),
    context: new ContextManager('test'),
    memory: new MemoryManager(),
  }).run();
  expect(task.status).toBe('completed');
  const goal = task.events.findIndex((event) => event.type === 'goal.updated');
  const review = task.events.findIndex(
    (event) => event.type === 'workflow.stage' && event.data.stage === 'review',
  );
  expect(goal).toBeGreaterThan(-1);
  expect(review).toBeGreaterThan(goal);
  expect(task.goal?.continuations).toBe(1);
});
