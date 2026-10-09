import { it, expect } from 'vitest';
import { z } from '../packages/agent-core/node_modules/zod';
import {
  AgentRunner,
  DevelopmentWorkflow,
  ContextManager,
  MemoryManager,
  EventBus,
  ToolRegistry,
  TaskManager,
  parseCheckpoint,
  type RunnerCheckpoint,
} from '../packages/agent-runtime/src';
import type { ModelRequest, ModelResponse, ModelProvider } from '../packages/agent-core/src';
it('routes structured role handoffs and bounds rejected review retries', async () => {
  const flow = new DevelopmentWorkflow();
  await expect(flow.advance('approved', 'invalid')).rejects.toThrow('Cannot approved');
  await flow.advance('handoff', 'Repository findings');
  expect(flow.state.stage).toBe('plan');
  await flow.advance('handoff', 'Concrete plan');
  for (let round = 0; round < 3; round++) {
    await flow.advance('verified', 'actual checks passed');
    await flow.advance('rejected', 'actionable finding');
    expect(flow.state.round).toBe(round + 1);
  }
  await flow.advance('verified', 'actual checks passed');
  await expect(flow.advance('rejected', 'fourth rejection')).rejects.toThrow('retries');
  await flow.advance('approved', 'Current files verified');
  expect(
    flow.allows({ name: 'read_file', description: '', parameters: {} }, new Set(['read_file'])),
  ).toBe(false);
  const restored = new DevelopmentWorkflow(flow.state);
  await restored.advance('revise', 'User added a new acceptance requirement');
  expect(restored.state).toMatchObject({ stage: 'implement', round: 0 });
  await restored.advance('verified', 'New acceptance requirement passed');
  expect(restored.state.stage).toBe('review');
});
it('gates review on actual acceptance, isolates the reviewer and denies writes during review', async () => {
  const tasks = new TaskManager(),
    task = tasks.create('Implement the exported API and preserve existing changes', '/tmp');
  task.runOptions = {
    mode: 'execute',
    workflow: 'development',
    maxSteps: 20,
    checks: [
      {
        id: 'test',
        kind: 'test',
        label: 'Actual check',
        command: 'node',
        args: ['test'],
        cwd: '.',
      },
    ],
  };
  const events = new EventBus(task),
    tools = new ToolRegistry();
  let writes = 0,
    tests = 0,
    checkpoint: RunnerCheckpoint | undefined;
  tools.register({
    name: 'read_file',
    description: 'inspect current implementation',
    permission: 'filesystem.read',
    schema: z.object({}),
    async execute() {
      return { content: 'file.ts exports the correct API and preserves user edits' };
    },
  });
  tools.register({
    name: 'write_fixture',
    description: 'write',
    permission: 'filesystem.write',
    schema: z.object({}),
    async execute() {
      writes++;
      events.emit('file.changed', { path: 'file.ts' });
      return { content: 'file changed' };
    },
  });
  tools.register({
    name: 'run_tests',
    description: 'tests',
    permission: 'shell.execute',
    schema: z.object({ command: z.string(), args: z.array(z.string()), cwd: z.string() }),
    async execute() {
      tests++;
      return {
        content: 'Passed actual fixture check',
        metadata: { exitCode: 0, command: 'node', args: ['test'], cwd: '.' },
      };
    },
  });
  const handoff = (id: string, report: string) => ({
    text: '',
    toolCalls: [{ id, name: 'handoff_stage', input: { report } }],
  });
  const responses: ModelResponse[] = [
    handoff(
      'investigate',
      'file.ts defines the exported API; no existing user edits should be overwritten.',
    ),
    handoff(
      'plan',
      'Modify file.ts, preserve exports, and run node test to verify the current changes.',
    ),
    {
      text: 'implementation-private-claim',
      toolCalls: [{ id: 'write', name: 'write_fixture', input: {} }],
    },
    { text: 'ready', toolCalls: [] },
    { text: 'ready after tests', toolCalls: [] },
    {
      text: 'attempt forbidden',
      toolCalls: [{ id: 'unsafe-review-write', name: 'write_fixture', input: {} }],
    },
    {
      text: '',
      toolCalls: [
        {
          id: 'premature-review',
          name: 'submit_review',
          input: {
            passed: true,
            findings: [],
            evidence: 'I assume the implementation is correct based on implementation claims.',
          },
        },
      ],
    },
    { text: '', toolCalls: [{ id: 'review-read', name: 'read_file', input: {} }] },
    {
      text: '',
      toolCalls: [
        {
          id: 'review',
          name: 'submit_review',
          input: {
            passed: true,
            findings: [],
            evidence: 'Reviewed file.ts exported API and the recorded node test acceptance result.',
          },
        },
      ],
    },
    { text: 'Verified final answer', toolCalls: [] },
  ];
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    countTokens: (text) => Math.ceil(text.length / 4),
    async chat() {
      return responses.shift()!;
    },
    async *stream(request) {
      requests.push(structuredClone({ ...request, signal: undefined }) as unknown as ModelRequest);
      yield await this.chat(request);
    },
  };
  await new AgentRunner(task, {
    tasks,
    events,
    tools,
    provider,
    permissions: { check: async () => true },
    memory: new MemoryManager(),
    context: new ContextManager('system'),
    checkpoints: {
      load: () => checkpoint,
      save: (_id, value) => {
        checkpoint = structuredClone(value);
      },
    },
  }).run();
  expect(task.status).toBe('completed');
  expect(writes).toBe(1);
  expect(
    task.events.some(
      (event) =>
        event.type === 'tool.failed' &&
        event.data.tool === 'submit_review' &&
        String(event.data.error).includes('current implementation'),
    ),
  ).toBe(true);
  expect(tests).toBe(1);
  expect(
    task.events.some(
      (event) => event.type === 'tool.failed' && event.data.tool === 'write_fixture',
    ),
  ).toBe(true);
  const review = requests.find((request) => request.messages[0]?.content.includes('REVIEWER:'))!;
  expect(review).toBeDefined();
  expect(JSON.stringify(review.messages)).not.toContain('implementation-private-claim');
  expect(review.tools.some((tool) => tool.name === 'write_fixture')).toBe(false);
  expect(parseCheckpoint(checkpoint)?.workflow?.stage).toBe('complete');
  expect(task.runSummary?.verification?.passed).toBe(true);
});
