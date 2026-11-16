import { expect, it } from 'vitest';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  prepareExecution,
  runExecution,
  verifyFileChecks,
} from '../../packages/agent-host/src/execution';
import {
  EventBus,
  ResourceScope,
  TaskManager,
  ToolRegistry,
} from '../../packages/agent-runtime/src/index';
import { FileChangeService } from '../../packages/tools/src/index';
import { LogicalSandboxProvider } from '../../packages/sandbox/src/index';
import type { ModelProvider } from '../../packages/agent-core/src/index';

it('rolls back all shared capability registrations when setup fails', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-execution-')));
  const resources = new ResourceScope();
  const tasks = new TaskManager();
  const task = tasks.create('setup', root);
  const events = new EventBus(task);
  const registry = new ToolRegistry();
  // WorkspaceOwnership normally creates .agent before setup.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, '.agent'));
  await writeFile(path.join(root, '.agent/hooks.json'), '{invalid');
  try {
    await expect(
      prepareExecution({
        task,
        tasks,
        events,
        tools: registry,
        resources,
        provider: {
          countTokens: () => 1,
          chat: async () => ({ text: '', toolCalls: [] }),
          async *stream() {
            yield { text: '', toolCalls: [] };
          },
        } satisfies ModelProvider,
        permissions: { check: async () => true },
        changes: new FileChangeService(root, events),
      }),
    ).rejects.toThrow();
    expect(registry.definitions()).toEqual([]);
  } finally {
    await resources.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('cleans up and flushes even when runner or resource cleanup fails', async () => {
  const resources = new ResourceScope();
  const order: string[] = [];
  resources.defer(() => {
    order.push('release');
  });
  resources.defer(() => {
    order.push('close');
    throw new Error('closer');
  });
  await expect(
    runExecution(
      {
        run: async () => {
          throw new Error('runner');
        },
      },
      resources,
      () => {
        order.push('flush');
      },
    ),
  ).rejects.toThrow('runner');
  expect(order).toEqual(['close', 'release', 'flush']);
});

it('uses the same bounded file acceptance checks for every host', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-acceptance-')));
  try {
    await writeFile(path.join(root, 'answer.txt'), 'verified');
    const report = await verifyFileChecks(
      [
        {
          id: 'text',
          label: 'answer',
          kind: 'file',
          path: 'answer.txt',
          exists: true,
          contains: 'verified',
        },
        { id: 'missing', label: 'absent', kind: 'file', path: 'missing', exists: false },
      ],
      root,
      new LogicalSandboxProvider(),
      new AbortController().signal,
    );
    expect(report.passed).toBe(true);
    const chat = await verifyFileChecks(
      [{ id: 'chat', label: 'blocked', kind: 'file', path: 'answer.txt', exists: true }],
      undefined,
      new LogicalSandboxProvider(),
      new AbortController().signal,
    );
    expect(chat.passed).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
