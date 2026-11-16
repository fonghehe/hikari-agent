import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  runOptionsSchema,
  type Task,
  type ModelProvider,
  type Decision,
  type PermissionRequest,
  type AgentEvent,
  type RunOptions,
  type UserQuestion,
  type Mandate,
} from '@hikari/agent-core';
import {
  AgentRunner,
  ToolRegistry,
  TaskManager,
  EventBus,
  FileRunStore,
  WorkspaceOwnership,
  ResourceScope,
  StateStore,
  type UsagePricing,
  type RetrievalOptions,
} from '@hikari/agent-runtime';
import { FileChangeService, TimelineService } from '@hikari/tools';
import { PermissionManager } from '@hikari/sandbox';
import { WorktreeService } from '@hikari/git';
import { runExecution } from './execution';
import { prepareAgentSession } from './prepare-session';

export interface SessionHostOptions {
  root: string;
  provider: ModelProvider;
  pricing?: UsagePricing;
  contextWindow?: number;
  supportsVision?: boolean;
  searchUrl?: string;
  retrieval?: Omit<RetrievalOptions, 'store' | 'namespace' | 'cache'>;
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
    assigned?: {
      taskId: string;
      mandate: Mandate;
      worktree?: string;
      configure?(tools: ToolRegistry): void;
      beforeRun?(runner: Pick<AgentRunner, 'pause' | 'cancel'>): void;
    },
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
    const task = saved ?? this.tasks.create(prompt, root, assigned?.taskId);
    if (assigned) task.mandate = structuredClone(assigned.mandate);
    if (assigned?.worktree) task.worktree = assigned.worktree;
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
      assigned?.configure?.(registry);
      const changes = new FileChangeService(executionRoot, events);
      this.changes.set(task.id, changes);
      const permissions = new PermissionManager(
        events,
        this.options.approve ?? (async () => 'deny'),
      );
      const prepared = await prepareAgentSession({
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
        contextWindow: this.options.contextWindow,
        memoryStore: this.store,
        controlStore: assigned ? undefined : new StateStore(root),
        retrieval: { ...this.options.retrieval, store: this.store.knowledge, namespace: root },
        restored,
        requestUser: this.options.requestUser,
        handoffMode: assigned ? 'report' : 'interactive',
        saveTask: (child, event) => this.store.recordTask({ ...child, workspace: root }, event),
      });
      const runner = prepared.runner;
      this.runners.set(task.id, runner);
      assigned?.beforeRun?.(runner);
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
