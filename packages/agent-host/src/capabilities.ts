import type {
  AgentEvent,
  Task,
  ModelProvider,
  PermissionManager as PermissionContract,
} from '@hikari/agent-core';
import {
  ResourceScope,
  TaskManager,
  SubagentTeam,
  WorkspaceOwnership,
  ToolRegistry,
  EventBus,
  type CheckpointStore,
  type UsagePricing,
  type RunnerCheckpoint,
} from '@hikari/agent-runtime';
import {
  FileChangeService,
  registerFileTools,
  registerGitTools,
  registerLSPTools,
  HookLifecycle,
  TimelineService,
  installedManifests,
  expandPlugin,
} from '@hikari/tools';
import type { MCPConnection } from '@hikari/mcp';
import { registerSkillTools } from '@hikari/skills';
import {
  LogicalSandboxProvider,
  NativeSandboxProvider,
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
  saveTask?(task: Task, event?: AgentEvent): void;
  onChildChanges?(task: Task, changes: FileChangeService): void;
}) {
  const resources = new ResourceScope();
  options = { ...options, tools: options.tools.scope(resources) };
  try {
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
    resources.defer(() => lsp.close());
    const hooks = await new HookLifecycle(
      task,
      events,
      permissions,
      extensionSandbox,
      changes,
    ).load(configRoot);
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
        const childResources = new ResourceScope();
        childResources.defer(release);
        try {
          const tools = new ToolRegistry().scope(childResources);
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
          const languageServers = await registerLSPTools(tools, childRoot, execution, configRoot);
          childResources.defer(() => languageServers.close());
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
            close: () => childResources.close(),
          };
        } catch (error) {
          await childResources.close().catch(() => {});
          throw error;
        }
      },
    });
    resources.defer(() => team.close());
    team.register();
    return {
      lifecycle: hooks,
      settleChildren: (signal: AbortSignal) => team.settle(signal),
      closeChildren: () => team.close(),
      timeline: async (phase: 'before' | 'after', checkpoint?: RunnerCheckpoint) => {
        await timeline.capture(task, checkpoint, phase);
      },
      close: () => resources.close(),
    };
  } catch (error) {
    await resources.close().catch(() => {});
    throw error;
  }
}
