import { realpath, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  runOptionsSchema,
  modeInstruction,
  type Task,
  type ModelProvider,
  type PermissionManager as PermissionContract,
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
  SubagentTeam,
  WorkspaceOwnership,
  registerMemoryTools,
  type CheckpointStore,
  type UsagePricing,
  type RunnerCheckpoint,
} from '@hikari/agent-runtime';
import {
  FileChangeService,
  registerFileTools,
  registerGitTools,
  registerBrowserTools,
  registerLSPTools,
  HookLifecycle,
  TimelineService,
  installedManifests,
  expandPlugin,
  projectInstructions,
  type InstalledPlugin,
} from '@hikari/tools';
import { registerMCPTools, type MCPConnection } from '@hikari/mcp';
import { registerSkillTools } from '@hikari/skills';
import {
  LogicalSandboxProvider,
  NativeSandboxProvider,
  PermissionManager,
  type SandboxProvider,
} from '@hikari/sandbox';
import { WorktreeService } from '@hikari/git';

export async function pluginMCP(root: string) {
  const result: Record<string, MCPConnection> = {};
  for (const { manifest, directory } of await installedManifests(root))
    for (const [name, value] of Object.entries(manifest.mcp))
      result[`${manifest.name}-${name}`] =
        value.transport === 'stdio'
          ? {
              ...value,
              command: expandPlugin(value.command, directory),
              args: value.args.map((arg) => expandPlugin(arg, directory)),
            }
          : value;
  return result;
}

export async function prepareCapabilities(options: {
  task: Task;
  tasks: TaskManager;
  events: EventBus;
  tools: ToolRegistry;
  provider: ModelProvider;
  permissions: PermissionContract;
  changes: FileChangeService;
  sandbox: SandboxProvider;
  configRoot?: string;
  checkpoints?: CheckpointStore;
  pricing?: UsagePricing;
  saveTask?(task: Task): void;
  onChildChanges?(task: Task, changes: FileChangeService): void;
}) {
  const { task, events, permissions, sandbox, changes } = options;
  const root = task.worktree ?? task.workspace;
  const configRoot = options.configRoot ?? task.workspace;
  const plugins = await installedManifests(configRoot);
  const extensionSandbox =
    sandbox instanceof NativeSandboxProvider
      ? new NativeSandboxProvider(
          root,
          sandbox.network,
          plugins.map((plugin) => plugin.directory),
        )
      : sandbox;
  const lsp = await registerLSPTools(options.tools, root, extensionSandbox, configRoot);
  const hooks = await new HookLifecycle(task, events, permissions, extensionSandbox, changes).load(
    configRoot,
  );
  const timeline = new TimelineService(root);
  const team = new SubagentTeam({
    parent: task,
    tasks: options.tasks,
    registry: options.tools,
    events,
    provider: options.provider,
    permissions,
    checkpoints: options.checkpoints,
    pricing: options.pricing,
    saveTask: options.saveTask,
    definitions: plugins.flatMap(({ manifest }) =>
      manifest.agents.map((agent) => ({ ...agent, name: `${manifest.name}-${agent.name}` })),
    ),
    createWorkspace: (child, signal) => {
      signal.throwIfAborted();
      return new WorktreeService(root).create(child.id, 'working-tree');
    },
    createTools: async (child, bus) => {
      const childRoot = child.worktree!;
      const release = new WorkspaceOwnership(childRoot).acquire(child.id);
      let languageServers: Awaited<ReturnType<typeof registerLSPTools>> | undefined;
      try {
        const tools = new ToolRegistry();
        const childChanges = new FileChangeService(childRoot, bus);
        options.onChildChanges?.(child, childChanges);
        const execution =
          task.runOptions?.execution === 'host'
            ? new LogicalSandboxProvider()
            : new NativeSandboxProvider(
                childRoot,
                task.runOptions?.allowNetwork,
                plugins.map((plugin) => plugin.directory),
              );
        registerFileTools(tools, execution, childChanges);
        registerGitTools(tools, childChanges);
        registerSkillTools(tools, configRoot);
        languageServers = await registerLSPTools(tools, childRoot, execution, configRoot);
        const lifecycle = await new HookLifecycle(
          child,
          bus,
          permissions,
          execution,
          childChanges,
        ).load(configRoot);
        return {
          tools,
          lifecycle,
          close: async () => {
            try {
              await languageServers?.close();
            } finally {
              release();
            }
          },
        };
      } catch (error) {
        try {
          await languageServers?.close();
        } finally {
          release();
        }
        throw error;
      }
    },
  });
  team.register();
  return {
    lifecycle: hooks,
    settleChildren: (signal: AbortSignal) => team.settle(signal),
    closeChildren: () => team.close(),
    timeline: async (phase: 'before' | 'after', checkpoint?: RunnerCheckpoint) => {
      await timeline.capture(task, checkpoint, phase);
    },
    close: async () => {
      await team.close();
      await lsp.close();
    },
  };
}

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
    const resources: (() => Promise<void>)[] = [];
    try {
      const events = new EventBus(task);
      events.subscribe((event) => {
        this.store.saveTask(task);
        this.options.publish?.(event);
      });
      const registry = new ToolRegistry();
      const changes = new FileChangeService(executionRoot, events);
      this.changes.set(task.id, changes);
      const sandbox =
        task.runOptions.execution === 'host'
          ? new LogicalSandboxProvider()
          : new NativeSandboxProvider(executionRoot, task.runOptions.allowNetwork);
      registerFileTools(registry, sandbox, changes);
      registerGitTools(registry, changes);
      registerMemoryTools(registry, this.store, root);
      registerSkillTools(registry, root);
      const mcp = registerMCPTools(registry, executionRoot, events, sandbox, undefined, root, () =>
        pluginMCP(root),
      );
      resources.push(() => mcp.close());
      const browser = registerBrowserTools(
        registry,
        events,
        this.options.supportsVision ?? false,
        this.options.searchUrl,
      );
      resources.push(() => browser.close());
      const permissions = new PermissionManager(
        events,
        this.options.approve ?? (async () => 'deny'),
      );
      const advanced = await prepareCapabilities({
        task,
        tasks: this.tasks,
        events,
        tools: registry,
        provider: this.options.provider,
        permissions,
        changes,
        sandbox,
        configRoot: root,
        checkpoints: this.store,
        pricing: this.options.pricing,
        saveTask: (child) => this.store.saveTask({ ...child, workspace: root }),
      });
      resources.push(() => advanced.close());
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
        ...advanced,
        verify: async (signal) => {
          const checks = [];
          for (const check of task.runOptions?.checks ?? []) {
            if (check.kind !== 'file') continue;
            signal.throwIfAborted();
            let passed = false;
            let detail = '';
            try {
              const filename = await sandbox.resolve(executionRoot, check.path);
              const info = await stat(filename).catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return undefined;
                throw error;
              });
              passed = !!info === check.exists;
              if (passed && check.contains !== undefined)
                passed =
                  !!info?.isFile() &&
                  info.size <= 2000000 &&
                  (await readFile(filename, 'utf8')).includes(check.contains);
              detail = passed ? 'Verified current file' : 'File acceptance failed';
            } catch (error) {
              detail = String(error);
            }
            checks.push({ id: check.id, label: check.label, passed, detail });
          }
          return { passed: checks.every((check) => check.passed), checks };
        },
      });
      this.runners.set(task.id, runner);
      this.store.saveTask(task);
      const completion = Promise.resolve()
        .then(() => runner.run())
        .finally(async () => {
          try {
            await Promise.allSettled(resources.map((close) => close()));
            this.store.saveTask(task);
          } finally {
            this.runners.delete(task.id);
            release();
          }
        });
      this.completions.set(task.id, completion);
      void completion.catch(() => {});
      return task;
    } catch (error) {
      try {
        await Promise.allSettled(resources.map((close) => close()));
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
  }
}
export type { InstalledPlugin };
export * from './remote';
export * from './interactive';
