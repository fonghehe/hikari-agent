import { z } from 'zod';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentError, type ModelProvider } from '../../packages/agent-core/src/index';
import { expect, it } from 'vitest';
import { classifyGrader, classifyTask, fingerprint, summarize } from '../../scripts/evals/evidence';
import {
  AgentRunner,
  EventBus,
  ToolRegistry,
  MemoryManager,
  ContextManager,
  TaskManager,
} from '../../packages/agent-runtime/src/index';

it('requires assertion evidence, structured outcomes or an explicit baseline contract', () => {
  expect(
    classifyGrader({ exitCode: 1, output: 'AssertionError [ERR_ASSERTION]: expected 5' }),
  ).toMatchObject({ validity: 'valid', passed: false });
  for (const output of [
    'Cannot find package dependency',
    'SyntaxError: unexpected token',
    'npm failed',
    '',
  ])
    expect(classifyGrader({ exitCode: 1, output })).toMatchObject({
      validity: 'invalid',
      passed: false,
    });
  expect(
    classifyGrader(
      { exitCode: 1, output: 'intended defect 42' },
      { exitCode: 1, outputIncludes: ['defect 42'] },
    ),
  ).toMatchObject({ validity: 'valid', passed: false });
  expect(
    classifyGrader(
      { exitCode: 2, output: 'AssertionError' },
      { exitCode: 1, outputIncludes: ['defect 42'] },
    ),
  ).toMatchObject({ validity: 'invalid' });
  for (const [status, code, validity] of [
    ['pass', 0, 'valid'],
    ['fail', 1, 'valid'],
    ['invalid', 1, 'invalid'],
    ['pass', 1, 'invalid'],
    ['fail', 0, 'invalid'],
  ] as const)
    expect(
      classifyGrader({ exitCode: code, output: `HIKARI_EVAL_RESULT ${JSON.stringify({ status })}` })
        .validity,
    ).toBe(validity);
  expect(classifyGrader({ exitCode: 1, output: 'HIKARI_EVAL_RESULT broken' }).validity).toBe(
    'invalid',
  );
});

it('keeps agent budget failures scored and excludes provider and unknown runtime failures', () => {
  const task = new TaskManager().create('offline', process.cwd());
  task.status = 'failed';
  for (const stopReason of ['STEP_LIMIT', 'TOKEN_BUDGET', 'TIME_BUDGET', 'MODEL_LENGTH']) {
    task.runSummary = {
      modelSteps: 1,
      toolCalls: 0,
      toolFailures: 0,
      durationMs: 10,
      filesChanged: [],
      tests: [],
      stopReason,
    };
    expect(classifyTask(task)).toMatchObject({ validity: 'valid', failureKind: 'agent' });
  }
  for (const stopReason of [
    'PROVIDER_HTTP',
    'TRUNCATED_STREAM',
    'MODEL_AUTH',
    'MODEL_RATE_LIMIT',
    'MODEL_REQUEST',
    'ERROR',
  ]) {
    task.runSummary!.stopReason = stopReason;
    expect(classifyTask(task).validity).toBe('invalid');
  }
  expect(
    summarize([{ case: 'one', validity: 'invalid', passed: false, durationMs: 10 }]),
  ).toMatchObject({ passed: false, samples: 0, invalidSamples: 1, successRate: 0 });
  expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
});

it('envelopes omit credentials and compare actual settings, budgets and case inputs', async () => {
  const { evidenceEnvelope } = await import('../../scripts/evals/evidence');
  const options = {
    suite: 'agent',
    evidence: 'model-run' as const,
    workflow: 'standard',
    config: {
      provider: 'compatible',
      model: 'fixture',
      apiKey: 'never-serialize-secret',
      baseUrl: 'http://user:password@127.0.0.1/v1?api_key=secret',
      streaming: false,
    },
    limits: { maxTokens: 1000 },
    inputs: { one: { prompt: 'fixture A' } },
    results: [{ case: 'one', passed: true, validity: 'valid' as const, durationMs: 3 }],
  };
  const report = await evidenceEnvelope(options);
  expect(JSON.stringify(report)).not.toMatch(/never-serialize-secret|password|api_key/);
  expect(report).toMatchObject({
    schemaVersion: 1,
    suite: 'agent',
    evidence: 'model-run',
    workflow: 'standard',
    samples: 1,
    invalidSamples: 0,
    successRate: 1,
    results: [{ case: 'one', name: 'one', validity: 'valid' }],
  });
  const budget = await evidenceEnvelope({ ...options, limits: { maxTokens: 2000 } });
  expect(budget.comparison.configuration).not.toBe(report.comparison.configuration);
  const input = await evidenceEnvelope({ ...options, inputs: { one: { prompt: 'fixture B' } } });
  expect(input.comparison.inputs.one).not.toBe(report.comparison.inputs.one);
});

it('scores actual acceptance rejection and repeated wrong-tool failures as agent failures', async () => {
  for (const repeatedTool of [false, true]) {
    const tasks = new TaskManager();
    const task = tasks.create('offline classification fixture', process.cwd());
    task.runOptions = { mode: 'execute', maxSteps: 10 };
    const events = new EventBus(task),
      tools = new ToolRegistry();
    tools.register({
      name: 'read_fixture',
      description: 'Read requested fixture path',
      permission: 'filesystem.read',
      schema: z.object({ path: z.string() }),
      execute: async () => {
        throw new Error('Requested path is missing');
      },
    });
    let calls = 0;
    const provider: ModelProvider = {
      countTokens: (text) => Math.ceil(text.length / 4),
      chat: async () =>
        repeatedTool
          ? {
              text: '',
              toolCalls: [
                { id: String(++calls), name: 'read_fixture', input: { path: 'wrong-file' } },
              ],
            }
          : { text: 'Done', toolCalls: [] },
      async *stream(request) {
        yield await this.chat(request);
      },
    };
    await new AgentRunner(task, {
      tasks,
      events,
      tools,
      provider,
      context: new ContextManager('offline fixture'),
      memory: new MemoryManager(),
      permissions: { check: async () => true },
      verify: async () => ({
        passed: false,
        checks: [
          {
            id: 'required',
            label: 'Required result',
            passed: false,
            detail: 'Missing required result',
          },
        ],
      }),
    }).run();
    expect(task.status).toBe('failed');
    expect(task.runSummary?.stopReason).toBe(
      repeatedTool ? 'REPEATED_TOOL_FAILURE' : 'ACCEPTANCE_FAILED',
    );
    expect(classifyTask(task)).toMatchObject({ validity: 'valid', failureKind: 'agent' });
  }
});

it('distinguishes pre-model environment failures from code errors after a healthy baseline', () => {
  for (const output of [
    'SyntaxError: unexpected token',
    "Cannot find package 'agent-import' imported from /checkout/changed.mjs",
    'TypeError: wrong return value',
  ]) {
    expect(classifyGrader({ exitCode: 1, output }).validity).toBe('invalid');
    expect(
      classifyGrader({ exitCode: 1, output }, undefined, {
        baselineValidated: true,
        agentChanged: true,
      }),
    ).toMatchObject({ validity: 'valid', passed: false, failureKind: 'agent' });
    expect(
      classifyGrader({ exitCode: 1, output }, undefined, {
        baselineValidated: true,
        agentChanged: false,
      }).validity,
    ).toBe('invalid');
  }
  expect(
    classifyGrader({ exitCode: 1, output: 'command not found' }, undefined, {
      baselineValidated: true,
      agentChanged: true,
    }).validity,
  ).toBe('invalid');
});

it('does not mistake a denied candidate command for unavailable sandbox infrastructure', () => {
  const task = new TaskManager().create('offline restriction fixture', process.cwd());
  task.status = 'failed';
  task.runSummary = {
    modelSteps: 3,
    toolCalls: 3,
    toolFailures: 3,
    durationMs: 10,
    filesChanged: [],
    tests: [],
    stopReason: 'REPEATED_TOOL_FAILURE',
  };
  const events = new EventBus(task);
  events.emit('tool.failed', { tool: 'shell', output: 'Operation not permitted' });
  expect(classifyTask(task)).toMatchObject({ validity: 'valid', failureKind: 'agent' });
  events.emit('tool.failed', {
    tool: 'shell',
    output: 'sandbox-exec: sandbox_apply: Operation not permitted',
  });
  expect(classifyTask(task)).toMatchObject({ validity: 'invalid', failureKind: 'environment' });
});

it('excludes actual missing native sandbox failures even when retries end in an agent stop', () => {
  for (const data of [
    { error: 'Error: Install bubblewrap to use the OS sandbox' },
    { error: 'Error: macOS sandbox-exec is unavailable' },
    { error: 'Error: This OS has no supported sandbox' },
    { error: 'Localized launch failure', metadata: { errorCode: 'SANDBOX_UNAVAILABLE' } },
  ]) {
    const task = new TaskManager().create('offline missing sandbox fixture', process.cwd());
    task.status = 'failed';
    task.runSummary = {
      modelSteps: 3,
      toolCalls: 3,
      toolFailures: 3,
      durationMs: 10,
      filesChanged: [],
      tests: [],
      stopReason: 'REPEATED_TOOL_FAILURE',
    };
    new EventBus(task).emit('tool.failed', { tool: 'run_tests', ...data });
    expect(classifyTask(task)).toMatchObject({ validity: 'invalid', failureKind: 'environment' });
  }
});

it('preserves structured infrastructure errors through actual tool execution', async () => {
  const tasks = new TaskManager(),
    task = tasks.create('offline sandbox fixture', process.cwd());
  task.runOptions = { mode: 'execute', maxSteps: 10 };
  const tools = new ToolRegistry(),
    events = new EventBus(task);
  tools.register({
    name: 'read_fixture',
    description: 'Read',
    permission: 'filesystem.read',
    schema: z.object({}),
    execute: async () => {
      throw new AgentError('SANDBOX_UNAVAILABLE', 'Localized startup failure');
    },
  });
  let turn = 0;
  const provider: ModelProvider = {
    countTokens: (value) => Math.ceil(value.length / 4),
    chat: async () => ({
      text: '',
      toolCalls: [{ id: String(++turn), name: 'read_fixture', input: {} }],
    }),
    async *stream(request) {
      yield await this.chat(request);
    },
  };
  await new AgentRunner(task, {
    tasks,
    tools,
    events,
    provider,
    context: new ContextManager('fixture'),
    memory: new MemoryManager(),
    permissions: { check: async () => true },
  }).run();
  expect(task.runSummary?.stopReason).toBe('REPEATED_TOOL_FAILURE');
  expect(task.events.find((event) => event.type === 'tool.failed')?.data.metadata).toMatchObject({
    errorCode: 'SANDBOX_UNAVAILABLE',
  });
  expect(classifyTask(task)).toMatchObject({ validity: 'invalid', failureKind: 'environment' });
});

it('binds report identity to transitive local harness sources and resolution configuration', async () => {
  const { harnessFingerprint } = await import('../../scripts/evals/evidence');
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-eval-harness-'));
  const packages = [
    'agent-core',
    'agent-runtime',
    'agent-host',
    'model-provider',
    'sandbox',
    'tools',
    'skills',
    'git',
    'shared',
    'mcp',
  ];
  try {
    await mkdir(path.join(root, 'scripts/evals'), { recursive: true });
    for (const name of packages) {
      await mkdir(path.join(root, 'packages', name, 'src'), { recursive: true });
      await writeFile(path.join(root, 'packages', name, 'package.json'), '{}');
    }
    for (const file of ['package.json', 'tsconfig.json', 'pnpm-workspace.yaml'])
      await writeFile(path.join(root, file), '{}');
    let previous = await harnessFingerprint(root);
    for (const file of [
      'packages/git/src/index.ts',
      'packages/shared/src/index.ts',
      'packages/mcp/src/index.ts',
      'tsconfig.json',
      'packages/git/package.json',
    ]) {
      await writeFile(
        path.join(root, file),
        file.endsWith('.ts') ? 'export const changed = true;' : '{"changed":true}',
      );
      const current = await harnessFingerprint(root);
      expect(current).not.toBe(previous);
      expect(await harnessFingerprint(root)).toBe(current);
      previous = current;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
