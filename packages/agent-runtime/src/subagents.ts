import { z } from 'zod';
import {
  AgentError,
  runOptionsSchema,
  planningTools,
  type Task,
  type EventSink,
  type ModelProvider,
  type PermissionManager,
  type ToolContext,
} from '@hikari/agent-core';
import {
  AgentRunner,
  ContextManager,
  MemoryManager,
  EventBus,
  TaskManager,
  ToolRegistry,
  type CheckpointStore,
  type UsagePricing,
} from './index';
import type { Lifecycle } from './lifecycle';

interface Child {
  task: Task;
  runner: AgentRunner;
  done: Promise<void>;
  tokens: number;
  cost: number;
}
export interface SubagentOptions {
  parent: Task;
  tasks: TaskManager;
  registry: ToolRegistry;
  events: EventSink;
  provider: ModelProvider;
  permissions: PermissionManager;
  pricing?: UsagePricing;
  checkpoints?: CheckpointStore;
  createWorkspace?(task: Task, signal: AbortSignal): Promise<string>;
  createTools?(
    task: Task,
    events: EventBus,
  ): Promise<{ tools: ToolRegistry; lifecycle?: Lifecycle; close(): Promise<void> }>;
  saveTask?(task: Task): void;
  definitions?: { name: string; description: string; instructions: string; writable: boolean }[];
}
export class SubagentTeam {
  private children = new Map<string, Child>();
  constructor(private options: SubagentOptions) {}
  register() {
    const { registry } = this.options;
    registry.register({
      name: 'spawn_agent',
      description:
        'Delegate a focused task to an isolated model context. Returns immediately; use wait_agent for its evidence. Read-only by default. Writable agents use separate worktrees; inspect their diffs before delivery. Available roles: ' +
        JSON.stringify(this.options.definitions ?? []),
      permission: 'filesystem.read',
      schema: z.object({
        prompt: z.string().trim().min(1).max(12000),
        role: z.string().max(80).optional(),
        writable: z.boolean().default(false),
        maxTokens: z.number().int().min(1000).max(100000).default(16000),
      }),
      execute: async (input, context) => ({
        content: JSON.stringify(await this.spawn(input, context)),
      }),
    });
    registry.register({
      name: 'wait_agent',
      description:
        'Wait for a delegated agent and retrieve its final answer, verification and worktree. Waiting is cancellable.',
      permission: 'filesystem.read',
      schema: z.object({ id: z.string().uuid() }),
      execute: async ({ id }, context) => {
        const child = this.get(id);
        await this.wait(child, context.signal);
        return {
          content: JSON.stringify({
            id,
            status: child.task.status,
            result: child.task.events.filter((event) => event.type === 'agent.completed').at(-1)
              ?.data.text,
            summary: child.task.runSummary,
            workspace: child.task.worktree,
            interrupted: child.task.status === 'interrupted',
          }),
        };
      },
    });
    registry.register({
      name: 'send_agent_message',
      description:
        'Send new evidence or instructions to a running delegated agent. Cannot address unrelated sessions.',
      permission: 'filesystem.read',
      schema: z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(12000) }),
      execute: async ({ id, text }) => {
        this.get(id).runner.enqueue(text);
        return { content: 'Message queued' };
      },
    });
    registry.register({
      name: 'cancel_agent',
      description: 'Cancel a delegated agent; retain its actual changes for review.',
      permission: 'filesystem.read',
      schema: z.object({ id: z.string().uuid() }),
      execute: async ({ id }) => {
        this.get(id).runner.cancel();
        return { content: 'Cancellation requested' };
      },
    });
  }
  private get(id: string) {
    const child = this.children.get(id);
    if (!child)
      throw new Error(
        'Unknown delegated agent in this run. Previously interrupted agents are never replayed; inspect their saved task and worktree.',
      );
    return child;
  }
  private async spawn(
    input: { prompt: string; role?: string; writable: boolean; maxTokens: number },
    context: ToolContext,
  ) {
    const { parent, tasks, registry, events, provider, permissions, checkpoints, pricing } =
      this.options;
    if (
      this.children.size >= 12 ||
      [...this.children.values()].filter(
        (child) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(child.task.status),
      ).length >= 3
    )
      throw new AgentError(
        'SUBAGENT_LIMIT',
        'At most three active agents and twelve delegations per run',
      );
    const role = input.role
      ? this.options.definitions?.find((role) => role.name === input.role)
      : undefined;
    if (input.role && !role) throw new Error('Unknown agent role');
    const writable = input.writable || !!role?.writable;
    if (parent.runOptions?.mode === 'plan')
      throw new Error('Delegation is unavailable in Plan mode');
    const reservations = [...this.children.values()].filter(
      (child) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(child.task.status),
    );
    const remaining =
      (parent.runOptions?.maxTokens ?? Infinity) -
      (parent.runSummary?.inputTokens ?? 0) -
      (parent.runSummary?.outputTokens ?? 0) -
      reservations.reduce((sum, item) => sum + item.tokens, 0);
    const tokens = Math.min(input.maxTokens, Math.floor(remaining / 2));
    if (tokens < 1000)
      throw new AgentError('TOKEN_BUDGET', 'Insufficient parent budget for delegation');
    const cost =
      parent.runOptions?.maxCostUsd === undefined
        ? 0
        : Math.max(
            0,
            (parent.runOptions.maxCostUsd -
              (parent.runSummary?.costUsd ?? 0) -
              reservations.reduce((sum, child) => sum + child.cost, 0)) /
              2,
          );
    if (parent.runOptions?.maxCostUsd !== undefined && cost <= 0)
      throw new AgentError('COST_BUDGET', 'Insufficient parent cost budget');
    const task = tasks.create(input.prompt, parent.worktree ?? parent.workspace);
    task.parentTaskId = parent.id;
    task.delegated = true;
    task.modelIdentity = parent.modelIdentity;
    task.modelProfileId = parent.modelProfileId;
    task.runOptions = runOptionsSchema.parse({
      mode: writable ? 'execute' : 'plan',
      maxSteps: 30,
      maxTokens: tokens,
      maxCostUsd: cost || undefined,
      maxDurationMs: Math.min(parent.runOptions?.maxDurationMs ?? 600000, 600000),
      execution: parent.runOptions?.execution,
      allowNetwork: parent.runOptions?.allowNetwork,
    });
    if (writable) {
      if (!this.options.createWorkspace || !this.options.createTools)
        throw new Error('Writable delegation is unavailable on this host');
      task.worktree = await this.options.createWorkspace(task, context.signal);
    }
    const bus = new EventBus(task);
    let services:
      | { tools: ToolRegistry; lifecycle?: Lifecycle; close(): Promise<void> }
      | undefined;
    try {
      services = writable
        ? await this.options.createTools!(task, bus)
        : {
            tools: registry.fork(
              (name, permission) => permission === 'filesystem.read' && planningTools.has(name),
            ),
            close: async () => {},
          };
      // A child can never acquire tools withheld from its parent by an active skill.
      services.tools.restrict(registry.definitions().map((definition) => definition.name));
      if (!services.tools.definitions().some((tool) => tool.name === 'send_agent_message'))
        services.tools.register({
          name: 'send_agent_message',
          description:
            'Send relevant evidence to a running sibling in the same parent task. Only known delegated agent IDs can be addressed.',
          permission: 'filesystem.read',
          schema: z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(12000) }),
          execute: async ({ id, text }) => {
            this.get(id).runner.enqueue(`[From delegated agent ${task.id}] ${text}`);
            return { content: 'Evidence queued for sibling' };
          },
        });
      const childContext = new ContextManager(
        'You are a delegated Hikari worker. Own only the assigned task. Inspect before editing; preserve other work. Return concise concrete evidence and limitations. ' +
          (writable
            ? 'Edits remain in your isolated worktree.'
            : 'Read-only investigation; do not claim to have changed files.') +
          '\n' +
          (role?.instructions ?? ''),
        Math.max(4096, Math.min(tokens - 1024, 24000)),
      );
      const runner = new AgentRunner(task, {
        tasks,
        events: bus,
        tools: services.tools,
        lifecycle: services.lifecycle,
        provider,
        permissions,
        context: childContext,
        memory: new MemoryManager(),
        checkpoints,
        pricing,
      });
      const child: Child = { task, runner, tokens, cost, done: Promise.resolve() };
      this.children.set(task.id, child);
      events.emit('subagent.reserved', { id: task.id, tokens, cost });
      const abort = () => runner.interrupt();
      context.signal.addEventListener('abort', abort, { once: true });
      bus.subscribe((event) => {
        this.options.saveTask?.(task);
        events.emit('subagent.event', { id: task.id, type: event.type, data: event.data });
      });
      this.options.saveTask?.(task);
      child.done = runner.run().finally(async () => {
        context.signal.removeEventListener('abort', abort);
        events.emit('subagent.settled', { id: task.id, tokens, cost, usage: task.runSummary });
        this.options.saveTask?.(task);
        await services!.close();
      });
      // Retain failures for wait_agent without creating an unhandled rejection.
      void child.done.catch(() => {});
      events.emit('subagent.spawned', {
        id: task.id,
        writable,
        worktree: task.worktree,
        prompt: input.prompt,
      });
      return { id: task.id, writable, worktree: task.worktree, maxTokens: tokens };
    } catch (error) {
      await services?.close();
      tasks.remove(task.id);
      throw error;
    }
  }
  private async wait(child: Child, signal: AbortSignal) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        child.runner.interrupt();
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      child.done.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  async settle(signal: AbortSignal) {
    await Promise.all([...this.children.values()].map((child) => this.wait(child, signal)));
  }
  async close() {
    for (const child of this.children.values()) child.runner.interrupt();
    await Promise.allSettled([...this.children.values()].map((child) => child.done));
  }
}
