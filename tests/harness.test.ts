import { expect, it } from 'vitest';
import { z } from '../packages/agent-core/node_modules/zod';
import {
  runOptionsSchema,
  taskPlanSchema,
  type ModelProvider,
  type ModelResponse,
  type Task,
} from '../packages/agent-core/src';
import {
  AgentRunner,
  ContextManager,
  EventBus,
  MemoryManager,
  TaskManager,
  ToolRegistry,
} from '../packages/agent-runtime/src';

function fixture(
  responses: ModelResponse[],
  configure: (tools: ToolRegistry, task: Task) => void = () => {},
) {
  const tasks = new TaskManager();
  const task = tasks.create('fixture', '/tmp');
  const events = new EventBus(task);
  const tools = new ToolRegistry();
  configure(tools, task);
  const definitions: string[][] = [];
  let approvals = 0;
  const provider: ModelProvider = {
    countTokens: (text) => Math.ceil(text.length / 4),
    chat: async (request) => {
      definitions.push(request.tools.map((tool) => tool.name));
      return responses.shift() ?? { text: 'done', toolCalls: [] };
    },
    async *stream(request) {
      yield await this.chat(request);
    },
  };
  const runner = new AgentRunner(task, {
    tasks,
    tools,
    events,
    provider,
    memory: new MemoryManager(),
    context: new ContextManager('fixture'),
    permissions: {
      async check() {
        approvals++;
        return true;
      },
    },
  });
  return { runner, task, definitions, approvals: () => approvals };
}
const call = (id: string, name: string, input: unknown): ModelResponse => ({
  text: '',
  toolCalls: [{ id, name, input }],
});

it('enforces Plan mode even if the model forges a hidden mutating tool call', async () => {
  let writes = 0;
  const plan = {
    steps: [
      { id: 'inspect', text: 'Inspect files', status: 'completed' },
      { id: 'edit', text: 'Propose a focused change', status: 'pending' },
    ],
  };
  const s = fixture(
    [
      call('plan', 'update_plan', plan),
      call('write', 'write_file', { text: 'unsafe' }),
      call('tests', 'run_tests', { command: 'forged' }),
    ],
    (tools, task) => {
      task.runOptions = { mode: 'plan', maxSteps: 8 };
      tools.register({
        name: 'write_file',
        description: 'write fixture',
        schema: z.object({ text: z.string() }),
        permission: 'filesystem.write',
        async execute() {
          writes++;
          return { content: 'written' };
        },
      });
    },
  );
  await s.runner.run();
  expect(writes).toBe(0);
  expect(s.approvals()).toBe(1); // only update_plan
  expect(s.definitions.every((definitions) => !definitions.includes('write_file'))).toBe(true);
  expect(s.task.plan?.steps).toEqual(plan.steps);
  expect(
    s.task.events.some(
      (event) =>
        event.type === 'tool.failed' &&
        String(event.data.error).includes('Plan mode cannot execute'),
    ),
  ).toBe(true);
  expect(s.task.runSummary?.filesChanged).toEqual([]);
  expect(s.task.runSummary?.tests[0]?.status).toBe('not_run');
});

it('stops three consecutive identical failures before spending the remaining model budget', async () => {
  let executions = 0;
  const s = fixture(
    Array.from({ length: 10 }, (_, i) => call(String(i), 'read_file', { path: 'missing' })),
    (tools) => {
      tools.register({
        name: 'read_file',
        description: 'fixture',
        schema: z.object({ path: z.string() }),
        permission: 'filesystem.read',
        async execute() {
          executions++;
          throw new Error('File missing');
        },
      });
    },
  );
  await s.runner.run();
  expect(executions).toBe(3);
  expect(s.task.status).toBe('failed');
  expect(s.task.runSummary).toMatchObject({
    modelSteps: 3,
    toolFailures: 3,
    stopReason: 'REPEATED_TOOL_FAILURE',
  });
});

it('a successful intervening edit resets repeated failure detection and records actual checks', async () => {
  let attempts = 0;
  const s = fixture(
    [
      call('test1', 'run_tests', { command: 'fixture-test' }),
      call('test2', 'run_tests', { command: 'fixture-test' }),
      call('edit', 'write_file', {}),
      call('test3', 'run_tests', { command: 'fixture-test' }),
    ],
    (tools) => {
      tools.register({
        name: 'run_tests',
        description: 'test',
        schema: z.object({ command: z.string() }),
        permission: 'shell.execute',
        async execute() {
          const exitCode = ++attempts < 3 ? 1 : 0;
          return { content: 'check output', error: exitCode !== 0, metadata: { exitCode } };
        },
      });
      tools.register({
        name: 'write_file',
        description: 'edit',
        schema: z.object({}),
        permission: 'filesystem.write',
        async execute(_input, context) {
          context.events.emit('file.changed', { path: 'fixture.ts' });
          return { content: 'edited' };
        },
      });
    },
  );
  await s.runner.run();
  expect(s.task.status).toBe('completed');
  expect(s.task.runSummary?.tests.map((test) => [test.status, test.exitCode])).toEqual([
    ['failed', 1],
    ['failed', 1],
    ['passed', 0],
  ]);
  expect(s.task.runSummary?.filesChanged).toEqual(['fixture.ts']);
});

it('does not treat model claims as verification and enforces a task-specific turn limit', async () => {
  const unverified = fixture([{ text: 'All tests pass', toolCalls: [] }]);
  await unverified.runner.run();
  expect(unverified.task.runSummary?.tests).toEqual([]);
  const bounded = fixture(
    [call('p', 'update_plan', { steps: [{ id: 'p', text: 'Plan', status: 'pending' }] })],
    (_tools, task) => {
      task.runOptions = { mode: 'plan', maxSteps: 1 };
    },
  );
  await bounded.runner.run();
  expect(bounded.task.status).toBe('failed');
  expect(bounded.task.runSummary?.stopReason).toBe('STEP_LIMIT');
  expect(() => runOptionsSchema.parse({ maxSteps: 0 })).toThrow();
  expect(() =>
    taskPlanSchema.parse({
      steps: [
        { id: 'a', text: 'a', status: 'in_progress' },
        { id: 'b', text: 'b', status: 'in_progress' },
      ],
    }),
  ).toThrow();
});

it('rejects an oversized tool batch before executing any action', async () => {
  let executions = 0;
  const response: ModelResponse = {
    text: '',
    toolCalls: Array.from({ length: 21 }, (_, i) => ({
      id: String(i),
      name: 'read_file',
      input: {},
    })),
  };
  const s = fixture([response], (tools) =>
    tools.register({
      name: 'read_file',
      description: 'fixture',
      schema: z.object({}),
      permission: 'filesystem.read',
      async execute() {
        executions++;
        return { content: 'read' };
      },
    }),
  );
  await s.runner.run();
  expect(executions).toBe(0);
  expect(s.task.runSummary?.stopReason).toBe('TOOL_BATCH_LIMIT');
});

it('records an interrupted check as failed evidence when the task is cancelled', async () => {
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const s = fixture([call('test', 'run_tests', { command: 'long-test' })], (tools) => {
    tools.register({
      name: 'run_tests',
      description: 'fixture',
      schema: z.object({ command: z.string() }),
      permission: 'shell.execute',
      async execute(_input, context) {
        ready();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), {
            once: true,
          });
        });
        return { content: 'unexpected success' };
      },
    });
  });
  const running = s.runner.run();
  await entered;
  s.runner.cancel();
  await running;
  expect(s.task.status).toBe('cancelled');
  expect(s.task.runSummary).toMatchObject({ stopReason: 'CANCELLED', toolFailures: 1 });
  expect(s.task.runSummary?.tests[0]).toMatchObject({ status: 'failed', exitCode: null });
});
