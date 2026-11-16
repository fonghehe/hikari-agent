import { modelConfigSchema } from '../../../packages/shared/src/index';
import { runOptionsSchema } from '@hikari/agent-core';
import { realpath } from 'node:fs/promises';
import { SessionHost } from '@hikari/agent-host';
import { handlePlatformCommand } from './platform';
import { createInterface } from 'node:readline/promises';
import {
  retrievalFromEnvironment,
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
const [, , action, ...words] = process.argv;
if (await handlePlatformCommand(action, words)) {
  // Platform commands manage their own bounded execution lifecycle.
} else if (!['run', 'resume'].includes(action ?? '') || !words.length) {
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
        ...retrievalFromEnvironment(),
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
    const root = await realpath(process.env.AGENT_WORKSPACE ?? process.cwd());
    const host = new SessionHost({
      root,
      provider: createModelProvider(config),
      modelIdentity: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
      contextWindow: config.contextWindow,
      supportsVision: config.supportsVision,
      searchUrl: config.searchUrl,
      retrieval: { embeddings: config.embeddings, reranker: config.reranker },
      pricing: {
        ...config,
        cachedInputPerMillion: process.env.AGENT_CACHED_INPUT_PRICE
          ? Number(process.env.AGENT_CACHED_INPUT_PRICE)
          : config.cachedInputPerMillion,
        cacheWriteInputPerMillion: process.env.AGENT_CACHE_WRITE_PRICE
          ? Number(process.env.AGENT_CACHE_WRITE_PRICE)
          : config.cacheWriteInputPerMillion,
        inputPerMillion: process.env.AGENT_INPUT_PRICE
          ? Number(process.env.AGENT_INPUT_PRICE)
          : config.inputPerMillion,
        outputPerMillion: process.env.AGENT_OUTPUT_PRICE
          ? Number(process.env.AGENT_OUTPUT_PRICE)
          : config.outputPerMillion,
      },
      publish: (event) => console.log(JSON.stringify(event)),
      approve: async (request, signal) => {
        if (!process.stdin.isTTY) return 'deny';
        const reader = createInterface({ input: process.stdin, output: process.stderr });
        try {
          return (
            await reader.question(
              `Approve ${request.tool}: ${JSON.stringify(request.input)}? [y/N] `,
              { signal },
            )
          ).toLowerCase() === 'y'
            ? 'once'
            : 'deny';
        } finally {
          reader.close();
        }
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
    });
    let interrupt = () => {};
    try {
      const saved = action === 'resume' ? host.saved(words[0]!) : undefined;
      if (action === 'resume' && !saved) throw new Error('Saved task not found in this workspace');
      const options = runOptionsSchema.parse(
        saved
          ? saved.runOptions
          : {
              mode: process.env.AGENT_MODE,
              workflow: process.env.AGENT_WORKFLOW,
              maxSteps: process.env.AGENT_MAX_STEPS
                ? Number(process.env.AGENT_MAX_STEPS)
                : undefined,
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
              goal: process.env.AGENT_GOAL
                ? {
                    objective: process.env.AGENT_GOAL,
                    maxContinuations: process.env.AGENT_GOAL_CONTINUATIONS
                      ? Number(process.env.AGENT_GOAL_CONTINUATIONS)
                      : 5,
                  }
                : undefined,
            },
      );
      const task = await host.start(saved?.prompt ?? words.join(' '), options, false, saved);
      console.error(`Task ${task.id} · resume with: pnpm agent resume ${task.id}`);
      interrupt = () => host.runners.get(task.id)?.interrupt();
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      await host.wait(task.id);
      if (task.status !== 'completed') process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      await host.close();
    }
  }
}
