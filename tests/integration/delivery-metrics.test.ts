import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TaskManager,
  EventBus,
  RunMetrics,
  usageCost,
  StateStore,
  SuperagentEngine,
} from '../../packages/agent-runtime/src/index';
import { LogicalSandboxProvider } from '../../packages/sandbox/src/index';
import { buildTaskDelivery } from '../../packages/agent-host/src/delivery-record';
import type { RunSummary } from '../../packages/agent-core/src/index';
import type { ModelProvider, ModelResponse } from '../../packages/agent-core/src/index';
import { SessionHost } from '../../packages/agent-host/src/index';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const summary = (): RunSummary => ({
  modelSteps: 1,
  toolCalls: 0,
  toolFailures: 0,
  durationMs: 0,
  filesChanged: [],
  tests: [],
});

it('does not promote empty checks or agent-proposed URLs into verified deliverables', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-delivery-'));
  roots.push(root);
  const task = new TaskManager().create('Deliver the result', root);
  task.status = 'completed';
  task.workReport = {
    status: 'ready',
    text: 'All done',
    reviewRequired: false,
    artifacts: [{ kind: 'url', locator: 'https://example.invalid/result', label: 'Proposed URL' }],
    unfinished: ['Device smoke not run'],
  };
  new EventBus(task).emit('agent.completed', { text: 'Actual final answer' });
  const run = summary();
  run.verification = { passed: true, checks: [] };
  const delivery = await buildTaskDelivery(task, run, new LogicalSandboxProvider());
  expect(delivery.verification).toBe('unverified');
  expect(delivery.artifacts[0]?.state).toBe('unverified');
  expect(delivery.artifacts[1]).toMatchObject({
    kind: 'answer',
    state: 'recorded',
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(delivery.unfinished).toContain('Device smoke not run');
  await writeFile(path.join(root, 'result.md'), 'deliverable');
  run.filesChanged = ['result.md', '.env', '../escape'];
  run.verification = {
    passed: true,
    checks: [
      {
        id: 'behavior',
        label: 'Independent behavior',
        passed: true,
        detail: 'Passed at current revision',
      },
    ],
  };
  const verified = await buildTaskDelivery(task, run, new LogicalSandboxProvider());
  expect(verified.verification).toBe('verified');
  expect(
    verified.artifacts.filter((item) => item.kind === 'file').map((item) => item.state),
  ).toEqual(['recorded', 'unavailable', 'unavailable']);
  expect(verified.humanAction?.kind).toBe('review');
  expect(
    (await buildTaskDelivery(task, run, new LogicalSandboxProvider(), ['create_issue']))
      .verification,
  ).toBe('unverified');
  task.status = 'interrupted';
  expect((await buildTaskDelivery(task, run, new LogicalSandboxProvider())).humanAction?.kind).toBe(
    'resume',
  );
});

it('counts distinct questions and approvals, unions overlapping waits and excludes restart downtime', () => {
  const task = new TaskManager().create('Measure', '/fixture'),
    events = new EventBus(task),
    run = summary();
  let now = 0;
  const metrics = new RunMetrics(run, undefined, () => now);
  events.subscribe((event) => metrics.observe(event));
  events.emit('agent.question', { question: { id: 'q1' } });
  now = 10;
  events.emit('permission.requested', { request: { id: 'p1' } });
  now = 20;
  events.emit('agent.answer');
  now = 30;
  events.emit('permission.denied');
  expect(run.attention).toMatchObject({
    questions: 1,
    approvals: 1,
    denials: 1,
    interventions: 2,
    waitingMs: 30,
    inputWaitMs: 20,
    permissionWaitMs: 20,
  });
  now = 1000;
  const resumed = new RunMetrics(run, metrics.seen, () => now);
  resumed.observe({
    id: 'event',
    taskId: task.id,
    agentId: task.agentId,
    timestamp: '',
    type: 'agent.question',
    data: { question: { id: 'q1' } },
  });
  expect(run.attention?.questions).toBe(1);
  now = 1010;
  resumed.tick();
  expect(run.attention?.waitingMs).toBe(40);
});

it('prices cache reads and writes independently, and preserves the configured fallback', () => {
  const usage = {
    inputTokens: 1000,
    outputTokens: 100,
    cachedInputTokens: 400,
    cacheWriteInputTokens: 100,
  };
  expect(
    usageCost(usage, {
      inputPerMillion: 2,
      outputPerMillion: 6,
      cachedInputPerMillion: 0.2,
      cacheWriteInputPerMillion: 3,
    }),
  ).toBeCloseTo(0.00198);
  expect(usageCost(usage, { inputPerMillion: 2, outputPerMillion: 6 })).toBeCloseTo(0.0026);
  expect(usageCost(usage)).toBeUndefined();
});

it('does not certify a blocked deliverable using acceptance from before a later mutation', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-delivery-revision-')));
  roots.push(root);
  await writeFile(path.join(root, 'result.txt'), 'before');
  const replies: ModelResponse[] = [
    { text: 'First phase complete', toolCalls: [] },
    {
      text: '',
      toolCalls: [
        {
          id: 'write',
          name: 'write_file',
          input: {
            path: 'result.txt',
            content: 'after',
            expectedHash: createHash('sha256').update('before').digest('hex'),
          },
        },
      ],
    },
    {
      text: '',
      toolCalls: [
        {
          id: 'blocked',
          name: 'report_work',
          input: {
            status: 'blocked',
            text: 'Changed the file; integration verification is still unavailable.',
          },
        },
      ],
    },
  ];
  const provider: ModelProvider = {
    countTokens: () => 1,
    chat: async () => replies.shift() ?? { text: 'unexpected', toolCalls: [] },
    async *stream(request) {
      yield await this.chat(request);
    },
  };
  const host = new SessionHost({ root, provider, approve: async () => 'once' });
  try {
    const task = await host.start('Complete both phases and verify the final result.', {
      mode: 'execute',
      maxSteps: 6,
      goal: { objective: 'Complete both phases', maxContinuations: 1 },
      checks: [
        {
          id: 'phase',
          label: 'Phase check',
          kind: 'test',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: '.',
        },
      ],
    });
    await host.wait(task.id);
    expect(
      task.events.some(
        (event) => event.type === 'agent.verification' && event.data.passed === true,
      ),
    ).toBe(true);
    expect(task.runSummary?.verification).toBeUndefined();
    expect(task.delivery).toMatchObject({
      verification: 'unverified',
      humanAction: { kind: 'inspect' },
    });
  } finally {
    await host.close();
  }
});

it('persists assessment costs, enforces the call budget and retains unknown billing after a crash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-accounting-'));
  roots.push(root);
  const engine = new SuperagentEngine(new StateStore(root));
  engine.configure({ sources: [], assessmentBudget: { maxCalls: 2 } });
  const trigger = {
    id: 'event',
    source: 'fixture',
    thread: 'thread',
    actor: 'operator',
    actorKind: 'human' as const,
    addressed: false,
    text: 'Check written rules',
  };
  const first = engine.beginAssessment(trigger);
  engine.finishAssessment(first, { inputTokens: 10, outputTokens: 5 }, 0.01);
  engine.finishAssessment(first, { inputTokens: 10, outputTokens: 5 }, 0.01);
  engine.beginAssessment({ ...trigger, id: 'lost-response' });
  const restarted = new SuperagentEngine(new StateStore(root));
  restarted.recover();
  expect(restarted.snapshot().accounting).toEqual({
    calls: 2,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.01,
    unpricedCalls: 1,
    unknownCalls: 1,
  });
  expect(() => restarted.beginAssessment(trigger)).toThrow('budget exhausted');
  restarted.configure({ sources: [], assessmentBudget: { maxCalls: 10, maxCostUsd: 1 } });
  expect(() => restarted.beginAssessment(trigger, 0.01)).toThrow('unknown billing');
  const other = new SuperagentEngine(new StateStore(root));
  // Incomplete pricing must not reset when policy changes.
  expect(() => other.beginAssessment(trigger)).toThrow('cost budget');
});
