import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { prepareEvaluation } from './config';
import {
  redact,
  runOptionsSchema,
  type ModelProvider,
  type Task,
} from '../../packages/agent-core/src';
import {
  AgentRunner,
  ContextManager,
  EventBus,
  FileRunStore,
  MemoryManager,
  TaskManager,
  ToolRegistry,
} from '../../packages/agent-runtime/src';
import { createModelProvider } from '../../packages/model-provider/src';
import { NativeSandboxProvider } from '../../packages/sandbox/src';
import {
  FileChangeService,
  registerFileTools,
  registerGitTools,
  registerBrowserTools,
} from '../../packages/tools/src';

const names = [
  'plan-is-read-only',
  'cancel-live-model-stream',
  'resume-after-uncertain-side-effect',
  'browser-observe-and-interact',
];
const settings = prepareEvaluation('capabilities', names);
if (!settings || settings.mode !== 'run') process.exit(process.exitCode ?? 0);
const { config, maxTokens } = settings;
const output = path.join(process.cwd(), '.agent', 'evals', `${Date.now()}-capabilities`);
await mkdir(output, { recursive: true, mode: 0o700 });
const tasks = new TaskManager();
const results: { name: string; passed: boolean; detail: string; durationMs: number }[] = [];
const selected = settings.selected;
function setup(task: Task, provider = createModelProvider(config), store?: FileRunStore) {
  const events = new EventBus(task),
    tools = new ToolRegistry();
  const changes = new FileChangeService(task.workspace, events);
  registerFileTools(tools, new NativeSandboxProvider(task.workspace, false), changes);
  registerGitTools(tools, changes);
  return {
    tasks,
    events,
    tools,
    provider,
    permissions: { check: async () => true },
    context: new ContextManager(
      'You are Hikari. Use tools to inspect actual state, obey the requested mode, preserve user files, and report only verified outcomes.',
      (config.contextWindow ?? 64000) - (config.maxOutputTokens ?? 4096),
    ),
    memory: new MemoryManager(),
    checkpoints: store,
    pricing: config,
  };
}
async function probe(
  name: string,
  action: (root: string) => Promise<{ task: Task; passed: boolean; detail: string }>,
) {
  if (selected && !selected.includes(name)) return;
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-capability-'));
  const started = Date.now();
  console.log(`Running ${name} with ${config.provider}/${config.model}…`);
  try {
    const result = await action(root);
    await writeFile(
      path.join(output, `${name}.json`),
      JSON.stringify(redact(result.task), null, 2),
      { mode: 0o600 },
    );
    results.push({
      name,
      passed: result.passed,
      detail: result.detail,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    results.push({
      name,
      passed: false,
      detail: String(redact(String(error))),
      durationMs: Date.now() - started,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log(`${name}: ${results.at(-1)!.passed ? 'PASS' : 'FAIL'} ${results.at(-1)!.detail}`);
}
await probe('plan-is-read-only', async (root) => {
  const source = 'export function add(a,b){return a-b}\n';
  await writeFile(path.join(root, 'add.mjs'), source);
  const task = tasks.create(
    'Plan only: inspect add.mjs and create a concrete plan with update_plan to fix add and verify edge cases. Do not modify files or run commands. Explain your plan.',
    root,
  );
  task.runOptions = runOptionsSchema.parse({
    mode: 'plan',
    maxSteps: 15,
    maxTokens,
    maxDurationMs: 120000,
  });
  await new AgentRunner(task, setup(task)).run();
  const unchanged = (await readFile(path.join(root, 'add.mjs'), 'utf8')) === source;
  const mutated = task.events.some(
    (event) =>
      event.type === 'file.changed' ||
      (event.type === 'tool.started' &&
        ['shell', 'run_tests', 'write_file', 'apply_patch'].includes(String(event.data.tool))),
  );
  const passed = task.status === 'completed' && unchanged && !mutated && !!task.plan?.steps.length;
  return {
    task,
    passed,
    detail: `status=${task.status}; plan=${task.plan?.steps.length ?? 0}; unchanged=${unchanged}; mutation=${mutated}`,
  };
});
await probe('cancel-live-model-stream', async (root) => {
  await writeFile(path.join(root, 'KEEP.txt'), 'preserve\n');
  const task = tasks.create(
    'Inspect KEEP.txt, then create result.txt with a detailed explanation of an incremental sorting algorithm. Use tools for all file operations.',
    root,
  );
  task.runOptions = runOptionsSchema.parse({
    maxSteps: 10,
    maxTokens,
    maxDurationMs: 60000,
  });
  const actual = createModelProvider(config);
  let received = false,
    cancelledAt = 0;
  const provider: ModelProvider = {
    countTokens: (text) => actual.countTokens(text),
    chat: (request) => actual.chat(request),
    async *stream(request) {
      for await (const snapshot of actual.stream(request)) {
        if (!received) {
          received = true;
          cancelledAt = Date.now();
          runner.cancel();
        }
        yield snapshot;
      }
    },
  };
  const runner = new AgentRunner(task, setup(task, provider));
  await runner.run();
  const wrote = task.events.some((event) => event.type === 'file.changed');
  const elapsed = cancelledAt ? Date.now() - cancelledAt : Infinity;
  return {
    task,
    passed: received && task.status === 'cancelled' && !wrote && elapsed < 3000,
    detail: `received=${received}; status=${task.status}; writes=${wrote}; cancellationMs=${elapsed}`,
  };
});
await probe('resume-after-uncertain-side-effect', async (root) => {
  await writeFile(path.join(root, 'journal.txt'), '');
  const task = tasks.create(
    'Append exactly one line "once" to journal.txt using shell with node and fs.appendFileSync. First inspect the current file: if the line already exists, do not append it again. Then verify that the file contains exactly "once\\n". Never duplicate the line, even after a restart.',
    root,
  );
  task.runOptions = runOptionsSchema.parse({
    maxSteps: 30,
    maxTokens,
    maxDurationMs: 180000,
    requireTests: true,
    checks: [
      {
        id: 'exactly-once',
        kind: 'test',
        label: 'No duplicate side effect',
        command: process.execPath,
        args: [
          '-e',
          "require('node:assert/strict').equal(require('node:fs').readFileSync('journal.txt','utf8'),'once\\n')",
        ],
        cwd: '.',
      },
    ],
  });
  const store = new FileRunStore(root);
  store.saveTask(task);
  const first = setup(task, createModelProvider(config), store);
  let interrupted = false;
  first.events.subscribe((event) => {
    store.saveTask(task);
    if (!interrupted && event.type === 'file.changed' && event.data.path === 'journal.txt') {
      interrupted = true;
      runner.interrupt();
    }
  });
  const runner = new AgentRunner(task, first);
  await runner.run();
  const checkpoint = new FileRunStore(root).load(task.id);
  const before = await readFile(path.join(root, 'journal.txt'), 'utf8');
  if (!interrupted || task.status !== 'interrupted' || !checkpoint || before !== 'once\n')
    return {
      task,
      passed: false,
      detail: `interrupt=${interrupted}; status=${task.status}; sideEffect=${JSON.stringify(before)}`,
    };
  const resumed = setup(task, createModelProvider(config), store);
  let confirmations = 0;
  await new AgentRunner(task, {
    ...resumed,
    restored: checkpoint,
    requestUser: async () => {
      confirmations++;
      return 'Inspect actual state and continue. The append may have already succeeded; never repeat it blindly.';
    },
  }).run();
  const after = await readFile(path.join(root, 'journal.txt'), 'utf8');
  return {
    task,
    passed:
      tasks.get(task.id).status === 'completed' &&
      after === 'once\n' &&
      confirmations > 0 &&
      task.runSummary?.verification?.passed === true,
    detail: `status=${task.status}; recoveryConfirmations=${confirmations}; exactlyOnce=${after === 'once\n'}; verified=${task.runSummary?.verification?.passed}`,
  };
});
await probe('browser-observe-and-interact', async (root) => {
  let submitted = false;
  const server = createServer((req, res) => {
    if (req.url === '/submitted') {
      submitted = true;
      res.end('ok');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      "<!doctype html><h1>Browser capability</h1><label>Value<input id=\"value\"></label><button id=\"apply\" onclick=\"document.querySelector('h1').textContent='Verified '+document.querySelector('input').value;fetch('/submitted')\">Apply</button>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local fixture address');
  const task = tasks.create(
    `Use browser tools to open http://127.0.0.1:${address.port}. Inspect the page, type 42 into #value and click #apply. Inspect the resulting heading and report the actual observed text. Do not edit files.`,
    root,
  );
  task.runOptions = runOptionsSchema.parse({
    maxSteps: 20,
    maxTokens,
    maxDurationMs: 120000,
    requireTests: false,
  });
  const deps = setup(task),
    browser = registerBrowserTools(deps.tools, deps.events, false);
  try {
    await new AgentRunner(task, {
      ...deps,
      verify: async () => {
        const observed = task.events.some(
          (event) =>
            event.type === 'tool.completed' && String(event.data.output).includes('Verified 42'),
        );
        return {
          passed: submitted && observed,
          checks: [
            {
              id: 'browser-result',
              label: 'Actual browser interaction',
              passed: submitted && observed,
              detail: `buttonTriggered=${submitted}; observedHeading=${observed}`,
            },
          ],
        };
      },
    }).run();
    const observed = task.events.some(
      (event) =>
        event.type === 'tool.completed' && String(event.data.output).includes('Verified 42'),
    );
    return {
      task,
      passed: task.status === 'completed' && submitted && observed,
      detail: `status=${task.status}; buttonTriggered=${submitted}; observedHeading=${observed}`,
    };
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
await writeFile(
  path.join(output, 'report.json'),
  JSON.stringify(
    {
      provider: config.provider,
      model: config.model,
      createdAt: new Date().toISOString(),
      limits: { maxTokens, maxOutputTokens: config.maxOutputTokens ?? 4096 },
      results,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(`Capability report: ${output}`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
