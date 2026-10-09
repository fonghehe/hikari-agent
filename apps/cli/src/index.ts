import { modelConfigSchema } from '../../../packages/shared/src';
import { runOptionsSchema, modeInstruction } from '@hikari/agent-core';
import { registerMCPTools } from '@hikari/mcp';
import { registerSkillTools } from '@hikari/skills';
import { realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import {
  FileRunStore,
  registerMemoryTools,
  AgentRunner,
  ContextManager,
  EventBus,
  MemoryManager,
  TaskManager,
  ToolRegistry,
} from '@hikari/agent-runtime';
import {
  createModelProvider,
  resolvedModelConfig,
  DemoProvider,
  demoWorkspace,
  demoFiles,
  demoTools,
} from '@hikari/model-provider';
import { NativeSandboxProvider, LogicalSandboxProvider, PermissionManager } from '@hikari/sandbox';
import {
  registerFileTools,
  registerGitTools,
  FileChangeService,
  registerBrowserTools,
} from '@hikari/tools';
const [, , action, ...words] = process.argv;
if (!['run', 'resume'].includes(action ?? '') || !words.length) {
  console.error(
    'Usage: pnpm agent run "fix eslint errors" | pnpm agent resume TASK_ID\nEnvironment: AGENT_API_KEY, AGENT_MODEL, AGENT_BASE_URL, AGENT_PROVIDER, AGENT_WORKSPACE',
  );
  process.exitCode = 1;
} else {
  const apiKey = process.env.AGENT_API_KEY ?? '';
  const model = process.env.AGENT_MODEL;
  const demo = process.env.AGENT_PROVIDER === 'demo' || (!process.env.AGENT_PROVIDER && !model);
  if (demo) {
    const tasks = new TaskManager();
    const task = tasks.create(words.join(' '), demoWorkspace.root);
    task.demo = true;
    task.runOptions = runOptionsSchema.parse({
      mode: process.env.AGENT_MODE,
      workflow: process.env.AGENT_WORKFLOW,
      maxSteps: process.env.AGENT_MAX_STEPS ? Number(process.env.AGENT_MAX_STEPS) : undefined,
    });
    const events = new EventBus(task);
    events.subscribe((event) => console.log(JSON.stringify(event)));
    const tools = new ToolRegistry();
    for (const tool of demoTools({ ...demoFiles }, () => {})) tools.register(tool);
    const runner = new AgentRunner(task, {
      tasks,
      events,
      tools,
      permissions: { check: async () => true },
      provider: new DemoProvider(),
      context: new ContextManager('Explicit offline demo; no real tests or local tools.'),
      memory: new MemoryManager(),
    });
    console.error('Offline simulation: no model requests, host files or real tests.');
    process.once('SIGINT', () => runner.cancel());
    await runner.run();
    if (task.status !== 'completed') process.exitCode = 1;
  } else {
    if (!model)
      throw new Error('Set AGENT_MODEL and AGENT_API_KEY (key optional for localhost providers)');
    const config = resolvedModelConfig(
      modelConfigSchema.parse({
        provider: process.env.AGENT_PROVIDER ?? 'compatible',
        apiKey,
        model,
        baseUrl: process.env.AGENT_BASE_URL,
        contextWindow: process.env.AGENT_CONTEXT_WINDOW
          ? Number(process.env.AGENT_CONTEXT_WINDOW)
          : undefined,
        maxOutputTokens: process.env.AGENT_MAX_OUTPUT_TOKENS
          ? Number(process.env.AGENT_MAX_OUTPUT_TOKENS)
          : undefined,
        streaming: process.env.AGENT_STREAMING !== 'false',
        supportsVision: process.env.AGENT_VISION === 'true',
        reasoningEffort: process.env.AGENT_REASONING_EFFORT,
      }),
    );
    const identity = { provider: config.provider, model: config.model, baseUrl: config.baseUrl };
    const tasks = new TaskManager();
    const root = await realpath(process.env.AGENT_WORKSPACE ?? process.cwd());
    const store = new FileRunStore(root);
    const task = action === 'resume' ? store.task(words[0]!) : tasks.create(words.join(' '), root);
    if (!task) throw new Error('Saved task not found in this workspace');
    if (
      task.modelIdentity &&
      (task.modelIdentity.provider !== identity.provider ||
        task.modelIdentity.model !== identity.model ||
        task.modelIdentity.baseUrl !== identity.baseUrl)
    )
      throw new Error(
        'Resume with the original provider, model and endpoint. Start a new task to switch models.',
      );
    task.modelIdentity = identity;
    const restored = action === 'resume' ? store.load(task.id) : undefined;
    if (action === 'resume') {
      if (!restored || restored.done)
        throw new Error('This task has no valid unfinished checkpoint');
      task.status = 'interrupted';
      tasks.restore(task);
    } else store.saveTask(task);
    task.runOptions = runOptionsSchema.parse(
      restored
        ? task.runOptions
        : {
            mode: process.env.AGENT_MODE,
            workflow: process.env.AGENT_WORKFLOW,
            maxSteps: process.env.AGENT_MAX_STEPS ? Number(process.env.AGENT_MAX_STEPS) : undefined,
            maxTokens: process.env.AGENT_MAX_TOKENS
              ? Number(process.env.AGENT_MAX_TOKENS)
              : undefined,
            maxCostUsd: process.env.AGENT_MAX_COST_USD
              ? Number(process.env.AGENT_MAX_COST_USD)
              : undefined,
            maxDurationMs: process.env.AGENT_MAX_MINUTES
              ? Number(process.env.AGENT_MAX_MINUTES) * 60000
              : undefined,
            execution: process.env.AGENT_EXECUTION ?? 'restricted',
            allowNetwork: process.env.AGENT_NETWORK === 'true',
          },
    );
    console.error(`Task ${task.id} · resume with: pnpm agent resume ${task.id}`);
    const events = new EventBus(task);
    events.subscribe((event) => {
      store.saveTask(task);
      console.log(JSON.stringify(event));
    });
    const tools = new ToolRegistry();
    const changes = new FileChangeService(task.workspace, events);
    const sandbox =
      task.runOptions.execution === 'host'
        ? new LogicalSandboxProvider()
        : new NativeSandboxProvider(root, task.runOptions.allowNetwork);
    registerFileTools(tools, sandbox, changes);
    registerMemoryTools(tools, store, root);
    registerGitTools(tools, changes);
    registerSkillTools(tools, task.workspace);
    const mcp = registerMCPTools(tools, task.workspace, events, sandbox);
    const browser = registerBrowserTools(tools, events, process.env.AGENT_VISION === 'true');
    const permissions = new PermissionManager(events, async (request, signal) => {
      if (!process.stdin.isTTY) return 'deny';
      const reader = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await reader.question(
          `Approve ${request.tool}: ${JSON.stringify(request.input)}? Execution uses the task's selected sandbox mode. [y/N] `,
          { signal },
        );
        return answer.toLowerCase() === 'y' ? 'once' : 'deny';
      } finally {
        reader.close();
      }
    });
    const runner = new AgentRunner(task, {
      tasks,
      events,
      tools,
      permissions,
      provider: createModelProvider(config),
      restored,
      checkpoints: store,
      pricing: {
        maxOutputTokens: config.maxOutputTokens,
        inputPerMillion: process.env.AGENT_INPUT_PRICE
          ? Number(process.env.AGENT_INPUT_PRICE)
          : undefined,
        outputPerMillion: process.env.AGENT_OUTPUT_PRICE
          ? Number(process.env.AGENT_OUTPUT_PRICE)
          : undefined,
      },
      requestUser: async (question, signal) => {
        if (!process.stdin.isTTY)
          throw new Error('Interactive input requires a terminal. Resume this task in a terminal.');
        const reader = createInterface({ input: process.stdin, output: process.stderr });
        try {
          return await reader.question(
            question.question + ' ' + (question.choices?.join(' / ') ?? '') + ' > ',
            { signal },
          );
        } finally {
          reader.close();
        }
      },
      context: new ContextManager(
        'You are a software development agent. Inspect before editing. Use tools for all local actions. Prefer focused patches. Test changes. Never claim tests ran unless a tool verified them.' +
          '\n' +
          modeInstruction(task.runOptions.mode),
        (config.contextWindow ?? 64000) - (config.maxOutputTokens ?? 4096),
      ),
      memory: new MemoryManager(),
    });
    process.once('SIGINT', () => runner.interrupt());
    process.once('SIGTERM', () => runner.interrupt());
    await runner.run().finally(async () => {
      await mcp.close();
      await browser.close();
      store.saveTask(task);
    });
    if (task.status !== 'completed') process.exitCode = 1;
  }
}
