import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  runOptionsSchema,
  modeInstruction,
  type Task,
  type ModelProvider,
  type Decision,
  type PermissionRequest,
  type AgentEvent,
  type RunOptions,
  type UserQuestion,
} from '@hikari/agent-core';
import {
  AgentRunner,
  ContextManager,
  MemoryManager,
  ToolRegistry,
  TaskManager,
  EventBus,
  FileRunStore,
  WorkspaceOwnership,
  ResourceScope,
  registerMemoryTools,
  type UsagePricing,
} from '@hikari/agent-runtime';
import {
  FileChangeService,
  TimelineService,
  projectInstructions,
  type InstalledPlugin,
} from '@hikari/tools';
import { PermissionManager } from '@hikari/sandbox';
import { WorktreeService } from '@hikari/git';
export { prepareCapabilities, pluginMCP } from './capabilities';
export * from './execution';
import { prepareExecution, runExecution, verifyFileChecks } from './execution';
export interface SessionHostOptions {
  root: string;
  provider: ModelProvider;
  pricing?: UsagePricing;
  contextWindow?: number;
  supportsVision?: boolean;
  searchUrl?: string;
  approve?(request: PermissionRequest, signal: AbortSignal): Promise<Decision>;
  publish?(event: AgentEvent): void;
  requestUser?(question: UserQuestion, signal: AbortSignal): Promise<string>;
  modelIdentity?: Task['modelIdentity'];
}
/** Shared local/CLI/worker execution host; the server never accepts a model credential in a task. */
export class SessionHost {
  readonly tasks = new TaskManager();
  readonly runners = new Map<string, AgentRunner>();
  readonly changes = new Map<string, FileChangeService>();
  private completions = new Map<string, Promise<void>>();
  private store: FileRunStore;
  constructor(readonly options: SessionHostOptions) {
    this.store = new FileRunStore(options.root);
    for (const task of this.store.tasks()) {
      if (
        !['completed', 'failed', 'cancelled'].includes(task.status) &&
        !WorkspaceOwnership.current(task.worktree ?? task.workspace) &&
        !WorkspaceOwnership.current(options.root)
      ) {
        task.status = 'interrupted';
        const checkpoint = this.store.load(task.id);
        task.resumable = !!checkpoint && !checkpoint.done;
        this.store.saveTask(task);
      }
      this.tasks.restore(task);
    }
  }
  async start(
    prompt: string,
    options: RunOptions = runOptionsSchema.parse({}),
    isolated = false,
    saved?: Task,
  ) {
    const root = await realpath(this.options.root);
    if (root !== this.options.root)
      throw new Error('Session host requires a canonical workspace path');
    const parsedOptions = runOptionsSchema.parse(options);
    if (isolated && parsedOptions.mode === 'plan')
      throw new Error('Plan mode does not create a worktree');
    if (saved && this.runners.has(saved.id))
      throw new Error('Workspace busy; task is already running');
    const restored = saved ? this.store.load(saved.id) : undefined;
    if (saved && (!restored || restored.done))
      throw new Error('No unfinished checkpoint; start a new task or rewind');
    const task = saved ?? this.tasks.create(prompt, root);
    if (
      saved?.modelIdentity &&
      JSON.stringify(saved.modelIdentity) !== JSON.stringify(this.options.modelIdentity)
    )
      throw new Error('Resume with the original provider, model and endpoint');
    task.modelIdentity ??= this.options.modelIdentity;
    task.runOptions = parsedOptions;
    if (saved) {
      if (saved.workspace !== root) throw new Error('Task belongs to another project');
      task.status = 'interrupted';
      this.tasks.restore(task);
    }
    if (isolated && !saved) {
      try {
        task.worktree = await new WorktreeService(root).create(task.id, 'working-tree');
      } catch (error) {
        task.status = 'failed';
        new EventBus(task).emit('agent.failed', { error: String(error) });
        this.store.saveTask(task);
        throw error;
      }
    }
    const executionRoot = task.worktree ?? root;
    let release: () => void;
    try {
      release = new WorkspaceOwnership(executionRoot).acquire(task.id);
    } catch (error) {
      if (!saved) this.tasks.remove(task.id);
      throw error;
    }
    const resources = new ResourceScope();
    try {
      const events = new EventBus(task);
      events.subscribe((event) => this.store.recordTask(task, event), { critical: true });
      events.subscribe((event) => this.options.publish?.(event));
      const registry = new ToolRegistry().scope(resources);
      const changes = new FileChangeService(executionRoot, events);
      this.changes.set(task.id, changes);
      registerMemoryTools(registry, this.store, root);
      const permissions = new PermissionManager(
        events,
        this.options.approve ?? (async () => 'deny'),
      );
      const prepared = await prepareExecution({
        task,
        tasks: this.tasks,
        events,
        tools: registry,
        provider: this.options.provider,
        permissions,
        changes,
        resources,
        configRoot: root,
        supportsVision: this.options.supportsVision,
        searchUrl: this.options.searchUrl,
        checkpoints: this.store,
        pricing: this.options.pricing,
        saveTask: (child, event) => this.store.recordTask({ ...child, workspace: root }, event),
      });
      const memory = new MemoryManager();
      memory.set(
        'Project guidance (subordinate to the user)',
        JSON.stringify(await projectInstructions(executionRoot)),
      );
      const runner = new AgentRunner(task, {
        tasks: this.tasks,
        events,
        tools: registry,
        provider: this.options.provider,
        permissions,
        context: new ContextManager(
          'You are Hikari. Inspect before editing. Use tools for actual actions. Preserve unrelated work. Verify changes and distinguish actual evidence from claims.\n' +
            modeInstruction(task.runOptions.mode),
          (this.options.contextWindow ?? 64000) - (this.options.pricing?.maxOutputTokens ?? 4096),
        ),
        memory,
        checkpoints: this.store,
        restored,
        pricing: this.options.pricing,
        requestUser: this.options.requestUser,
        ...prepared.runtime,
        verify: (signal) =>
          verifyFileChecks(task.runOptions?.checks ?? [], executionRoot, prepared.sandbox, signal),
      });
      this.runners.set(task.id, runner);
      this.store.saveTask(task);
      const completion = Promise.resolve()
        .then(() =>
          runExecution(runner, resources, () => {
            this.store.flush(task.id);
            this.store.saveTask(task);
          }),
        )
        .finally(() => {
          this.runners.delete(task.id);
          release();
        });
      this.completions.set(task.id, completion);
      void completion.catch(() => {});
      return task;
    } catch (error) {
      try {
        await resources.close().catch(() => {});
        task.status = 'failed';
        new EventBus(task).emit('agent.failed', { error: String(error) });
        this.store.saveTask(task);
        this.changes.delete(task.id);
      } finally {
        release();
      }
      throw error;
    }
  }
  async wait(id: string) {
    await this.completions.get(id);
    return this.tasks.get(id);
  }
  saved(id: string) {
    return this.store.task(id);
  }
  async rewind(id: string, mode: 'code' | 'conversation' | 'both') {
    if (this.runners.size) throw new Error('Finish all project tasks before restoring history');
    const timeline = new TimelineService(this.options.root);
    const result = await timeline.restore(
      id,
      mode,
      new FileChangeService(this.options.root, { emit() {} }),
    );
    if (!result) return;
    const task = {
      ...result.task,
      id: randomUUID(),
      agentId: randomUUID(),
      parentTaskId: result.task.id,
      status: 'interrupted' as const,
      events: [],
      resumable: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.store.saveTask(task);
    this.store.save(task.id, result.checkpoint);
    return task;
  }
  async close() {
    for (const runner of this.runners.values()) runner.interrupt();
    await Promise.allSettled([...this.completions.values()]);
    this.store.close();
  }
}
export type { InstalledPlugin };
export * from './remote';
export * from './interactive';
