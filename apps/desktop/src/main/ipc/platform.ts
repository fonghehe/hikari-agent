import { dialog, Notification } from 'electron';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hookSchema, lspConfigSchema, runOptionsSchema, type Task } from '@hikari/agent-core';
import { StateStore, AutomationService, automationInput } from '@hikari/agent-runtime';
import { PluginManager, TimelineService, FileChangeService } from '@hikari/tools';
import { LogicalSandboxProvider } from '@hikari/sandbox';
import { RemoteControlServer } from '@hikari/agent-host';
import { id, resolveProjectRoot, type DesktopContext, type RegisterHandler } from './context';

export function registerPlatformHandlers(handle: RegisterHandler, context: DesktopContext) {
  const { host, persistence } = context;
  const root = (input?: unknown) => resolveProjectRoot(context, input);
  const services = new Map<string, AutomationService>();
  let remote: RemoteControlServer | undefined;
  let remoteInfo: { root: string; url: string; token: string } | undefined;
  const service = (workspace: string) => {
    let value = services.get(workspace);
    if (!value) {
      value = new AutomationService(new StateStore(workspace));
      value.recover();
      services.set(workspace, value);
    }
    return value;
  };
  for (const workspace of (persistence.get('model_configs', 'scheduled-workspaces')?.data ??
    []) as string[]) {
    try {
      service(workspace);
    } catch {
      /* A removed workspace is displayed when reopened. */
    }
  }
  const timer = setInterval(() => {
    for (const [workspace, schedule] of services)
      void schedule
        .tick(
          async (item) => {
            if (!host.config || host.config.provider === 'demo')
              throw new Error('Scheduled tasks require a real model');
            if (item.modelProfileId && !host.profiles.has(item.modelProfileId))
              throw new Error('Scheduled task model profile is unavailable');
            const task = await host.start(
              item.prompt,
              workspace,
              item.isolated,
              undefined,
              item.options,
              [],
              undefined,
              item.modelProfileId,
            );
            schedule.attach(item.id, task.id);
            await new Promise<void>((resolve) => {
              const check = setInterval(() => {
                if (!host.runners.has(task.id)) {
                  clearInterval(check);
                  resolve();
                }
              }, 100);
              check.unref();
            });
            return {
              taskId: task.id,
              status: task.status,
              result: String(
                task.events.filter((event) => event.type === 'agent.completed').at(-1)?.data.text ??
                  task.runSummary?.stopReason ??
                  task.status,
              ),
            };
          },
          (item) => {
            if (Notification.isSupported())
              new Notification({
                title: `Hikari · ${item.name}`,
                body: `${item.last?.status}: ${item.last?.result.slice(0, 200)}`,
              }).show();
          },
        )
        .catch(() => {
          /* Concurrent daemon ownership is reported through the schedule state. */
        });
  }, 1000);
  timer.unref();
  host.disposers.add(() => {
    clearInterval(timer);
    for (const value of services.values()) value.close();
    void remote?.close();
  });
  const inactive = (taskId: unknown) => {
    const task = host.tasks.get(id.parse(taskId));
    if (task.chat || task.demo) throw new Error('History restoration requires a real project task');
    if (
      host.tasks
        .list()
        .some(
          (other) =>
            (other.worktree ?? other.workspace) === (task.worktree ?? task.workspace) &&
            host.runners.has(other.id),
        )
    )
      throw new Error('Finish all tasks in this workspace before restoring history');
    return task;
  };
  const rewind = async (
    task: Task,
    checkpointId: string,
    mode: 'code' | 'conversation' | 'both',
  ) => {
    const executionRoot = task.worktree ?? task.workspace;
    const timeline = new TimelineService(executionRoot);
    if (timeline.read(checkpointId).taskId !== task.id)
      throw new Error('Checkpoint belongs to another task');
    const changes =
      host.changes.get(task.id) ?? new FileChangeService(executionRoot, { emit() {} });
    const result = await timeline.restore(checkpointId, mode, changes);
    persistence.task(task, undefined, changes.history);
    if (!result) return;
    const restored = host.tasks.create(result.task.prompt, task.workspace);
    Object.assign(restored, {
      runOptions: result.task.runOptions,
      modelProfileId: result.task.modelProfileId,
      modelIdentity: result.task.modelIdentity,
      worktree: task.worktree,
      parentTaskId: task.parentTaskId,
      status: 'interrupted',
      resumable: true,
      goal: result.checkpoint.goal,
    });
    persistence.task(restored);
    persistence.checkpoints.save(restored.id, result.checkpoint);
    return restored;
  };
  const readConfig = async (kind: 'hooks' | 'lsp', workspace: string): Promise<unknown> => {
    const filename = await new LogicalSandboxProvider().resolve(workspace, `.agent/${kind}.json`);
    const text = await readFile(filename, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '[]';
      throw error;
    });
    if (text.length > 128000) throw new Error('Configuration exceeds 128 KB');
    return JSON.parse(text) as unknown;
  };
  handle('platform:list', async (workspaceRoot) => {
    const workspace = await root(workspaceRoot);
    return {
      automations: service(workspace).list(),
      plugins: new PluginManager(workspace).list(),
      hooks: z
        .array(hookSchema)
        .max(50)
        .parse(await readConfig('hooks', workspace)),
      lsp: z
        .array(lspConfigSchema)
        .max(20)
        .parse(await readConfig('lsp', workspace)),
      remote:
        remoteInfo?.root === workspace
          ? { url: remoteInfo.url, token: remoteInfo.token }
          : undefined,
    };
  });
  handle('platform:schedule', async (input, workspaceRoot) => {
    const workspace = await root(workspaceRoot);
    if (!host.config || host.config.provider === 'demo')
      throw new Error('Connect a real model before scheduling tasks');
    service(workspace).create({
      ...automationInput.parse(input),
      modelProfileId: host.config.profileId,
    });
    persistence.save('model_configs', 'scheduled-workspaces', [...services.keys()]);
  });
  handle('platform:updateSchedule', async (value, enabled, workspaceRoot) =>
    service(await root(workspaceRoot)).update(
      id.parse(value),
      z.boolean().nullable().parse(enabled),
    ),
  );
  handle('platform:importPlugin', async (update, workspaceRoot) => {
    const workspace = await root(workspaceRoot);
    if (host.tasks.list().some((task) => task.workspace === workspace && host.runners.has(task.id)))
      throw new Error('Finish active project tasks before changing plugins');
    const picked = await dialog.showOpenDialog(context.window, { properties: ['openDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return false;
    await new PluginManager(workspace).install(
      picked.filePaths[0],
      undefined,
      z.boolean().default(false).parse(update),
    );
    return true;
  });
  handle('platform:removePlugin', async (name, workspaceRoot) => {
    const workspace = await root(workspaceRoot);
    if (host.tasks.list().some((task) => task.workspace === workspace && host.runners.has(task.id)))
      throw new Error('Finish active project tasks before changing plugins');
    return new PluginManager(workspace).remove(z.string().parse(name));
  });
  handle('platform:registry', async (source, workspaceRoot) =>
    new PluginManager(await root(workspaceRoot)).registry(
      z.string().min(1).max(4000).parse(source),
    ),
  );
  handle('platform:installRegistry', async (entry, update, workspaceRoot) => {
    const workspace = await root(workspaceRoot);
    if (host.tasks.list().some((task) => task.workspace === workspace && host.runners.has(task.id)))
      throw new Error('Finish active project tasks before changing plugins');
    const value = z
      .object({
        name: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
        version: z.string().max(100),
        path: z.string().min(1).max(4000),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(entry);
    await new PluginManager(workspace).install(
      value.path,
      value.sha256,
      z.boolean().default(false).parse(update),
      { name: value.name, version: value.version },
    );
  });
  handle('platform:configure', async (kind, entries, workspaceRoot) => {
    const workspace = await root(workspaceRoot);
    const section = z.enum(['hooks', 'lsp']).parse(kind);
    if (host.tasks.list().some((task) => task.workspace === workspace && host.runners.has(task.id)))
      throw new Error('Finish active project tasks before changing extensions');
    const parsed =
      section === 'hooks'
        ? z.array(hookSchema).max(50).parse(entries)
        : z.array(lspConfigSchema).max(20).parse(entries);
    if (
      new Set(parsed.map((entry) => ('id' in entry ? entry.id : entry.name))).size !== parsed.length
    )
      throw new Error('Configuration names must be unique');
    const sandbox = new LogicalSandboxProvider();
    const directory = await sandbox.resolve(workspace, '.agent');
    await mkdir(directory, { recursive: true });
    const filename = await sandbox.resolve(workspace, `.agent/${section}.json`);
    const temporary = path.join(directory, randomUUID() + '.tmp');
    await writeFile(temporary, JSON.stringify(parsed, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  });
  handle('platform:remoteStart', async (bind, port, workspaceRoot) => {
    if (remote) throw new Error('Remote control is already running');
    if (!host.config || host.config.provider === 'demo')
      throw new Error('Connect a real model before starting remote control');
    const workspace = await root(workspaceRoot);
    const server = new RemoteControlServer({
      root: workspace,
      list: () => host.tasks.list().filter((task) => task.workspace === workspace),
      start: (prompt, options, isolated) =>
        host.start(prompt, workspace, isolated, undefined, runOptionsSchema.parse(options)),
      control: async (taskId, action) => host.control(taskId, action),
      input: (taskId, text) => host.input(taskId, text),
      approve: (taskId, requestId, decision) => host.approve(taskId, requestId, decision),
      answer: (taskId, questionId, text) => host.answer(taskId, questionId, text),
      rewind: (checkpointId, mode) =>
        rewind(
          inactive(new TimelineService(workspace).read(checkpointId).taskId),
          checkpointId,
          mode,
        ),
    });
    const value = await server.listen(
      z.number().int().min(0).max(65535).default(4319).parse(port),
      z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1').parse(bind),
    );
    remote = server;
    remoteInfo = { root: workspace, url: `http://${value.host}:${value.port}`, token: value.token };
    return remoteInfo;
  });
  handle('platform:remoteStop', async (workspaceRoot) => {
    const workspace = await root(workspaceRoot);
    if (remoteInfo && remoteInfo.root !== workspace)
      throw new Error('Remote control belongs to another project');
    await remote?.close();
    remote = undefined;
    remoteInfo = undefined;
  });
  handle('platform:timeline', (taskId) => {
    const task = host.tasks.get(id.parse(taskId));
    return task.chat || task.demo
      ? []
      : new TimelineService(task.worktree ?? task.workspace).list(task.id);
  });
  handle('platform:previewRewind', (taskId, checkpointId) => {
    const task = inactive(taskId);
    const timeline = new TimelineService(task.worktree ?? task.workspace);
    if (timeline.read(id.parse(checkpointId)).taskId !== task.id)
      throw new Error('Checkpoint belongs to another task');
    return timeline.preview(id.parse(checkpointId));
  });
  handle('platform:rewind', (taskId, checkpointId, mode) =>
    rewind(
      inactive(taskId),
      id.parse(checkpointId),
      z.enum(['code', 'conversation', 'both']).parse(mode),
    ),
  );
}
