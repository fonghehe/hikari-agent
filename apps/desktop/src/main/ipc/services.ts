import { secureStorageAvailable, purgeWeakCredentials } from '../secret-storage';
import { createHash } from 'node:crypto';
import { app, dialog, safeStorage } from 'electron';
import { z } from 'zod';
import { ExtensionManager } from '../extensions';
import { UpdateService } from '../updates';
import { SyncClient } from '../sync';
import { id, resolveProjectRoot, type DesktopContext, type RegisterHandler } from './context';

export function registerServicesHandlers(handle: RegisterHandler, context: DesktopContext) {
  const { host, persistence, terminals, workspaceState } = context;
  purgeWeakCredentials(safeStorage, () => {
    persistence.repository.db
      .prepare(
        "DELETE FROM model_configs WHERE owner='local' AND (id IN ('provider','profiles') OR substr(id,1,10)='mcp-token:')",
      )
      .run();
  });
  const root = () => workspaceState.require();
  const sync = new SyncClient(persistence);
  const extensionManager = async (input?: unknown, writing = false) => {
    const workspace = await resolveProjectRoot(context, input);
    if (
      writing &&
      host.tasks.list().some((task) => task.workspace === workspace && host.runners.has(task.id))
    )
      throw new Error('Finish the active workspace task before changing extensions');
    return { manager: new ExtensionManager(workspace), workspace };
  };
  handle('extensions:list', async (workspaceRoot) =>
    (await extensionManager(workspaceRoot)).manager.list(),
  );
  const mcpTokens = new Map<string, string>();
  const tokenKey = (root: string, name: string) =>
    'mcp-token:' +
    createHash('sha256')
      .update(JSON.stringify([root, name]))
      .digest('hex');
  host.mcpHeaders = (root, name) => {
    const key = tokenKey(root, name);
    let token = mcpTokens.get(key);
    const encrypted = persistence.get('model_configs', key)?.data;
    if (!token && typeof encrypted === 'string' && secureStorageAvailable(safeStorage)) {
      try {
        token = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch {
        throw new Error(
          'MCP credential could not be decrypted. Save the token again in workspace settings.',
        );
      }
    }
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  };
  handle('extensions:server', async (name, config, workspaceRoot) => {
    const { manager, workspace } = await extensionManager(workspaceRoot, true);
    const serverName = z.string().parse(name);
    const token =
      config === null
        ? ''
        : z.object({ authToken: z.string().max(4000).optional() }).parse(config).authToken;
    await manager.server(serverName, config);
    if (token !== undefined) {
      const key = tokenKey(workspace, serverName);
      mcpTokens.set(key, token);
      persistence.save(
        'model_configs',
        key,
        secureStorageAvailable(safeStorage) && token
          ? safeStorage.encryptString(token).toString('base64')
          : null,
      );
    }
  });
  handle('extensions:importSkill', async (workspaceRoot) => {
    const { manager } = await extensionManager(workspaceRoot, true);
    const result = await dialog.showOpenDialog(context.window, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return false;
    await manager.installSkill(result.filePaths[0]);
    return true;
  });
  handle('extensions:removeSkill', async (directory, workspaceRoot) =>
    (await extensionManager(workspaceRoot, true)).manager.removeSkill(z.string().parse(directory)),
  );
  const updates = new UpdateService(
    app.isPackaged,
    app.getVersion(),
    () => host.runners.size === 0,
  );
  handle('updates:status', () => updates.status());
  handle('updates:check', () => updates.check());
  handle('updates:download', () => updates.download());
  handle('updates:install', () => updates.install());
  handle('sync:connect', (input) => {
    const value = z
      .object({
        url: z.string().url(),
        email: z.string().email(),
        password: z.string().min(12).max(256),
        register: z.boolean(),
      })
      .parse(input);
    return sync.connect(value.url, value.email, value.password, value.register);
  });
  handle('sync:push', (taskId) => sync.push(host.tasks.get(id.parse(taskId))));
  handle('sync:status', () => sync.status());
  handle('sync:pull', () => sync.pull());
  handle('sync:logout', () => sync.logout());
  handle('sync:import', async (value) => {
    const record = sync.remote(id.parse(value));
    const snapshot = z
      .object({
        title: z.string().max(120),
        prompt: z.string().max(24000),
        events: z.array(z.object({ type: z.string(), data: z.record(z.unknown()) })).max(2000),
      })
      .parse(record.data);
    const task = host.tasks.create(
      snapshot.prompt,
      workspaceState.root ?? 'chat://hikari/imported',
    );
    task.title = snapshot.title;
    task.chat = !workspaceState.root || undefined;
    task.imported = true;
    const final = snapshot.events
      .slice()
      .reverse()
      .find((event) => event.type === 'agent.completed');
    const bus = new (await import('@hikari/agent-runtime')).EventBus(task);
    bus.emit('agent.state', { state: 'planning' });
    bus.emit('agent.state', { state: 'thinking' });
    bus.emit('agent.completed', {
      text:
        typeof final?.data.text === 'string'
          ? final.data.text
          : 'Imported task snapshot. Inspect the current local workspace before continuing.',
    });
    bus.emit('agent.state', { state: 'completed' });
    persistence.task(task);
    return task;
  });
  handle(
    'browser:preview',
    (taskId) => host.browsers.get(id.parse(taskId))?.preview() ?? { url: '' },
  );
  handle('terminal:create', async (taskId) => {
    const task = taskId ? host.tasks.get(id.parse(taskId)) : undefined;
    if (task?.demo) throw new Error('Demo tasks do not open real terminals');
    if (task?.chat)
      throw new Error('Open a workspace and start a new task before using a terminal');
    const workspace = task ? (task.worktree ?? task.workspace) : root();
    const result = await dialog.showMessageBox(context.window, {
      type: 'warning',
      buttons: ['Cancel', 'Open terminal'],
      defaultId: 0,
      cancelId: 0,
      message: 'Open a local shell?',
      detail: `This interactive terminal runs with your user account permissions in ${workspace}. It is not an OS sandbox.`,
    });
    if (result.response !== 1) throw new Error('Terminal cancelled');
    return terminals.create(workspace);
  });
  handle('terminal:write', (terminalId, data) =>
    terminals.write(id.parse(terminalId), z.string().max(16384).parse(data)),
  );
  handle('terminal:resize', (terminalId, cols, rows) =>
    terminals.resize(
      id.parse(terminalId),
      z.number().int().min(2).max(500).parse(cols),
      z.number().int().min(1).max(200).parse(rows),
    ),
  );
  handle('terminal:kill', (terminalId) => terminals.kill(id.parse(terminalId)));
}
