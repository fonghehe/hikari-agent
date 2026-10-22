import { expect, it } from 'vitest';
import { z } from '../packages/agent-core/node_modules/zod';
import {
  AgentRunner,
  ContextManager,
  EventBus,
  MemoryManager,
  TaskManager,
  ToolRegistry,
} from '../packages/agent-runtime/src';
import type { RunnerCheckpoint, Lifecycle } from '../packages/agent-runtime/src';
import type { ModelProvider, ModelRequest } from '../packages/agent-core/src';

function fixture(lifecycle?: Lifecycle, names?: string[], denyIndex?: number) {
  const tasks = new TaskManager();
  const task = tasks.create('inspect', '/tmp');
  const tools = new ToolRegistry();
  const started: number[] = [];
  const releases = Array.from({ length: 4 }, () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { release, gate };
  });
  let active = 0,
    maximum = 0,
    step = 0;
  let saved: RunnerCheckpoint | undefined;
  const requests: ModelRequest[] = [];
  const read = {
    name: 'read_file',
    description: 'Read fixture',
    permission: 'filesystem.read' as const,
    parallelSafe: true,
    schema: z.object({ index: z.number() }),
    async execute(
      { index }: { index: number },
      context: import('../packages/agent-core/src').ToolContext,
    ) {
      started.push(index);
      maximum = Math.max(maximum, ++active);
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(context.signal.reason);
          context.signal.addEventListener('abort', abort, { once: true });
          void releases[index]!.gate.then(() => {
            context.signal.removeEventListener('abort', abort);
            resolve();
          });
          if (context.signal.aborted) abort();
        });
        return { content: `result-${index}` };
      } finally {
        active--;
      }
    },
  };
  tools.register(read);
  tools.register({ ...read, name: 'write_file', permission: 'filesystem.write' });
  tools.register({ ...read, name: 'unmarked_read', parallelSafe: undefined });
  const provider: ModelProvider = {
    countTokens: (text) => text.length / 4,
    async chat() {
      return ++step === 1
        ? {
            text: '',
            toolCalls: releases.map((_, index) => ({
              id: `call-${index}`,
              name: names?.[index] ?? 'read_file',
              input: { index },
            })),
          }
        : { text: 'done', toolCalls: [] };
    },
    async *stream(request) {
      requests.push(structuredClone({ ...request, signal: undefined }) as unknown as ModelRequest);
      yield await this.chat(request);
    },
  };
  const runner = new AgentRunner(task, {
    tasks,
    tools,
    provider,
    context: new ContextManager('system'),
    memory: new MemoryManager(),
    events: new EventBus(task),
    permissions: {
      check: async (request) => (request.input as { index: number }).index !== denyIndex,
    },
    lifecycle,
    checkpoints: {
      load: () => saved,
      save: (_id, checkpoint) => {
        saved = structuredClone(checkpoint);
      },
    },
  });
  return {
    task,
    tools,
    runner,
    started,
    releases,
    requests,
    maximum: () => maximum,
    active: () => active,
    saved: () => saved,
  };
}

it('overlaps at most three explicit reads and commits results in model call order', async () => {
  const f = fixture();
  const running = f.runner.run();
  try {
    await expect.poll(() => f.started).toEqual([0, 1, 2]);
    f.releases[2]!.release();
    f.releases[1]!.release();
    f.releases[0]!.release();
    await expect.poll(() => f.started).toEqual([0, 1, 2, 3]);
    f.releases[3]!.release();
    await running;
    expect(f.maximum()).toBe(3);
    expect(
      f.requests[1]?.messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.content),
    ).toEqual(['result-0', 'result-1', 'result-2', 'result-3']);
    expect(f.task.runSummary).toMatchObject({ modelSteps: 2, toolCalls: 4 });
  } finally {
    f.releases.forEach((gate) => gate.release());
    await running;
  }
});

it('keeps tools sequential when hooks can have side effects', async () => {
  const f = fixture({ dispatch: async () => {} });
  f.releases.forEach((gate) => gate.release());
  await f.runner.run();
  expect(f.maximum()).toBe(1);
  expect(f.task.status).toBe('completed');
});

it('settles interrupted reads before returning and keeps their recovery state', async () => {
  const f = fixture();
  const running = f.runner.run();
  try {
    await expect.poll(() => f.started).toEqual([0, 1, 2]);
    f.runner.interrupt();
    await running;
    expect(f.active()).toBe(0);
    expect(f.task.status).toBe('interrupted');
    expect(f.saved()?.pending.filter((entry) => entry.state === 'running')).toHaveLength(3);
    expect(f.saved()?.pending[3]?.state).toBe('ready');
  } finally {
    f.releases.forEach((gate) => gate.release());
    await running;
  }
});

it('treats writes and unmarked reads as serial barriers even if a write is marked parallel', async () => {
  for (const names of [
    ['read_file', 'read_file', 'write_file', 'read_file'],
    ['unmarked_read', 'unmarked_read', 'unmarked_read', 'unmarked_read'],
  ]) {
    const f = fixture(undefined, names);
    f.releases.forEach((gate) => gate.release());
    await f.runner.run();
    expect(f.maximum()).toBe(names[0] === 'read_file' ? 2 : 1);
    expect(f.started).toEqual([0, 1, 2, 3]);
    expect(f.task.status).toBe('completed');
  }
});

it('does not execute a denied read and preserves its paired error observation', async () => {
  const f = fixture(undefined, undefined, 1);
  f.releases.forEach((gate) => gate.release());
  await f.runner.run();
  expect(f.started).toEqual([0, 2, 3]);
  const results = f.requests[1]?.messages.filter((message) => message.role === 'tool');
  expect(results?.map((message) => message.toolCallId)).toEqual([
    'call-0',
    'call-1',
    'call-2',
    'call-3',
  ]);
  expect(results?.[1]?.content).toContain('Permission denied');
});
