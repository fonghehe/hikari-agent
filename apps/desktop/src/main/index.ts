import { readFile, writeFile, stat } from 'node:fs/promises';
import { redact } from '@hikari/agent-core';
import { createHash } from 'node:crypto';
import { ExtensionManager } from './extensions';
import { UpdateService } from './updates';
import { LocalPersistence } from './persistence';
import { SyncClient } from './sync';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  safeStorage,
  nativeTheme,
  nativeImage,
  clipboard,
  shell,
} from 'electron';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import { runOptionsSchema } from '@hikari/agent-core';
import {
  modelConfigSchema,
  preferencesSchema,
  attachmentLimits,
  type ModelConfig,
} from '@hikari/shared';
import { GitService, WorktreeService } from '@hikari/git';
import { RepositoryIndexer, WorktreeDelivery, FileChangeService } from '@hikari/tools';
import {
  createModelProvider,
  listModels,
  resolvedModelConfig,
  demoWorkspace,
} from '@hikari/model-provider';
import { openWorkspace, readWorkspaceFile } from './workspace';
import { TaskHost } from './task-host';
import { TerminalSessions } from './terminal';
import { desktopDataPath } from './data-path';
// Keep existing tasks and settings in place; never copy a possibly active SQLite database.
const dataPath = desktopDataPath(
  app.getPath('appData'),
  app.getPath('userData'),
  process.env.HIKARI_DATA_DIR || process.env.FORGE_DATA_DIR,
);
mkdirSync(dataPath.directory, { recursive: true, mode: 0o700 });
app.setPath('userData', dataPath.directory);
app.setName('Hikari');
app.setAppUserModelId('dev.hikari.agent');
let workspaceRoot: string | undefined;
let window: BrowserWindow;
const host = new TaskHost((event) => {
  if (window && !window.isDestroyed()) window.webContents.send('agent:event', event);
});
const terminals = new TerminalSessions((event) => {
  if (window && !window.isDestroyed()) window.webContents.send('terminal:data', event);
});
app.whenReady().then(() => {
  const persistence = new LocalPersistence(dataPath.database);
  host.initialize(persistence);
  const sync = new SyncClient(persistence);
  const storedPreferences = preferencesSchema.safeParse(
    persistence.get('model_configs', 'app-preferences')?.data ?? {},
  );
  let preferences = storedPreferences.success
    ? storedPreferences.data
    : preferencesSchema.parse({});
  nativeTheme.themeSource = preferences.theme;
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icons/hikari.png')
    : path.join(app.getAppPath(), 'resources/icons/hikari.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) app.dock?.setIcon(icon);
  const saved = persistence.get('model_configs', 'provider')?.data;
  if (typeof saved === 'string' && safeStorage.isEncryptionAvailable()) {
    try {
      host.config = modelConfigSchema.parse(
        JSON.parse(safeStorage.decryptString(Buffer.from(saved, 'base64'))),
      );
    } catch {
      /* A locked OS keychain requires reconnecting. */
    }
  }
  const savedProfiles = persistence.get('model_configs', 'profiles')?.data;
  if (typeof savedProfiles === 'string' && safeStorage.isEncryptionAvailable()) {
    try {
      const profiles = z
        .array(modelConfigSchema)
        .max(30)
        .parse(JSON.parse(safeStorage.decryptString(Buffer.from(savedProfiles, 'base64'))));
      for (const profile of profiles)
        if (profile.profileId) host.profiles.set(profile.profileId, profile);
    } catch {
      /* A locked keychain leaves profiles unavailable until reconfigured. */
    }
  }
  if (host.config && !host.config.profileId)
    host.config.profileId = createHash('sha256')
      .update(JSON.stringify([host.config.provider, host.config.baseUrl, host.config.model]))
      .digest('hex')
      .slice(0, 32);
  if (host.config?.profileId) host.profiles.set(host.config.profileId, host.config);
  const persistProfiles = () => {
    if (safeStorage.isEncryptionAvailable()) {
      persistence.save(
        'model_configs',
        'profiles',
        safeStorage.encryptString(JSON.stringify([...host.profiles.values()])).toString('base64'),
      );
      persistence.save(
        'model_configs',
        'provider',
        safeStorage.encryptString(JSON.stringify(host.config ?? null)).toString('base64'),
      );
    }
  };
  const publicConfig = (config: ModelConfig): ModelConfig => ({
    ...config,
    apiKey: '',
    embeddings: config.embeddings ? { ...config.embeddings, apiKey: '' } : undefined,
  });
  window = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#10131a' : '#fbfcff',
    icon,
    title: 'Hikari',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  const check = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error('Untrusted IPC sender');
  };
  const root = () => {
    if (!workspaceRoot) throw new Error('Open a workspace first');
    return workspaceRoot;
  };
  const handle = (name: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(name, (event, ...args: unknown[]) => {
      check(event);
      return fn(...args);
    });
  const id = z.string().uuid();
  handle('clipboard:write', (text) => clipboard.writeText(z.string().max(1000000).parse(text)));
  handle('external:open', (input) => {
    const url = new URL(z.string().url().max(4096).parse(input));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Only HTTP and HTTPS links can be opened');
    return shell.openExternal(url.toString());
  });
  handle('attachments:pick', async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile', 'multiSelections'],
    });
    return result.canceled ? { items: [], errors: [] } : host.attachments.pick(result.filePaths);
  });
  handle('attachments:import', (files) =>
    host.attachments.import(
      z
        .array(
          z.object({
            name: z.string().max(200),
            bytes: z
              .instanceof(Uint8Array)
              .refine(
                (bytes) => bytes.byteLength <= attachmentLimits.maxFileBytes,
                'Each file must be at most 10 MB',
              ),
          }),
        )
        .max(attachmentLimits.maxFiles)
        .parse(files),
    ),
  );
  handle('attachments:read', (attachmentId) => host.attachments.read(id.parse(attachmentId)));
  handle('preferences:get', () => preferences);
  handle('preferences:set', (value) => {
    preferences = preferencesSchema.parse(value);
    persistence.save('model_configs', 'app-preferences', preferences);
    nativeTheme.themeSource = preferences.theme;
    window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#10131a' : '#fbfcff');
    return preferences;
  });
  handle('workspace:recent', () =>
    persistence.repository
      .listSync('workspaces', 'local')
      .filter((record) => !record.id.startsWith('demo:'))
      .map((record) => record.data as { root: string; name: string })
      .filter((item) => typeof item.root === 'string' && typeof item.name === 'string')
      .slice(0, 30),
  );
  handle('workspace:select', async (value) => {
    const selected = z.string().min(1).max(4000).parse(value);
    if (!persistence.get('workspaces', selected))
      throw new Error('Select a previously opened workspace or use the folder picker');
    const workspace = await openWorkspace(selected);
    workspaceRoot = workspace.root;
    persistence.save('workspaces', workspace.root, { root: workspace.root, name: workspace.name });
    try {
      workspace.files = await new RepositoryIndexer(workspace.root).findFiles();
    } catch {
      /* Directory fallback. */
    }
    return workspace;
  });
  handle('workspace:open', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
    const selected = result.filePaths[0];
    if (result.canceled || !selected) return null;
    const workspace = await openWorkspace(selected);
    workspaceRoot = workspace.root;
    persistence.save('workspaces', workspace.root, { root: workspace.root, name: workspace.name });
    try {
      workspace.files = await new RepositoryIndexer(workspace.root).findFiles();
    } catch {
      /* Directory listing is a fallback when rg is absent. */
    }
    return workspace;
  });
  handle('workspace:read', (file, taskId) => {
    const task = taskId ? host.tasks.get(id.parse(taskId)) : undefined;
    const filename = z.string().max(4096).parse(file);
    if (task?.chat)
      throw new Error(
        'This conversation has no project files. Open a workspace and start a new task.',
      );
    if (task?.demo) {
      const files = host.demos.get(task.id)?.files;
      if (!files || !Object.hasOwn(files, filename)) throw new Error('Demo file not found');
      return files[filename];
    }
    return readWorkspaceFile(task ? (task.worktree ?? task.workspace) : root(), filename);
  });
  handle('workspace:snapshot', async (taskId) => {
    const task = taskId ? host.tasks.get(id.parse(taskId)) : undefined;
    if (task?.chat) return null;
    if (task?.demo)
      return {
        ...demoWorkspace,
        root: task.workspace,
        files: Object.keys(host.demos.get(task.id)?.files ?? {}),
      };
    const selected = task ? (task.worktree ?? task.workspace) : workspaceRoot;
    if (!selected) return null;
    const workspace = await openWorkspace(selected);
    try {
      workspace.files = await new RepositoryIndexer(workspace.root).findFiles();
    } catch {
      /* Keep directory fallback. */
    }
    return workspace;
  });
  handle('agent:configure', (config) => {
    const next = modelConfigSchema.parse(config);
    const key =
      next.profileId ??
      createHash('sha256')
        .update(JSON.stringify([next.provider, next.baseUrl, next.model]))
        .digest('hex')
        .slice(0, 32);
    const old = host.profiles.get(key) ?? host.config;
    if (!next.apiKey && old?.provider === next.provider && old.baseUrl === next.baseUrl)
      next.apiKey = old.apiKey;
    if (
      next.embeddings &&
      !next.embeddings.apiKey &&
      old?.embeddings?.model === next.embeddings.model &&
      old.embeddings.baseUrl === next.embeddings.baseUrl
    )
      next.embeddings.apiKey = old.embeddings.apiKey;
    if (!host.profiles.has(key) && host.profiles.size >= 30)
      throw new Error('At most 30 model profiles are supported');
    host.config = resolvedModelConfig({ ...next, profileId: key });
    host.profiles.set(key, host.config);
    persistProfiles();
  });
  handle('agent:profiles', () => [...host.profiles.values()].map(publicConfig));
  handle('agent:activateProfile', (value) => {
    const profile = host.profiles.get(z.string().max(80).parse(value));
    if (!profile) throw new Error('Unknown model profile');
    host.config = profile;
    persistProfiles();
  });
  handle('agent:removeProfile', (value) => {
    const key = z.string().max(80).parse(value);
    if (
      host.tasks
        .list()
        .some(
          (task) =>
            task.modelProfileId === key &&
            !['completed', 'failed', 'cancelled'].includes(task.status),
        )
    )
      throw new Error('Finish or cancel tasks using this model profile before removing it');
    host.profiles.delete(key);
    if (host.config?.profileId === key) host.config = [...host.profiles.values()][0];
    persistProfiles();
  });
  const extensionManager = () => {
    if (!workspaceRoot) throw new Error('Open a workspace to manage its extensions');
    if (
      host.tasks
        .list()
        .some((task) => task.workspace === workspaceRoot && host.runners.has(task.id))
    )
      throw new Error('Finish the active workspace task before changing extensions');
    return new ExtensionManager(workspaceRoot);
  };
  handle('extensions:list', () => extensionManager().list());
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
    if (!token && typeof encrypted === 'string' && safeStorage.isEncryptionAvailable()) {
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
  handle('extensions:server', async (name, config) => {
    const manager = extensionManager();
    const serverName = z.string().parse(name);
    const token =
      config === null
        ? ''
        : z.object({ authToken: z.string().max(4000).optional() }).parse(config).authToken;
    await manager.server(serverName, config);
    if (token !== undefined) {
      const key = tokenKey(workspaceRoot!, serverName);
      mcpTokens.set(key, token);
      persistence.save(
        'model_configs',
        key,
        safeStorage.isEncryptionAvailable() && token
          ? safeStorage.encryptString(token).toString('base64')
          : null,
      );
    }
  });
  handle('extensions:importSkill', async () => {
    const manager = extensionManager();
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return false;
    await manager.installSkill(result.filePaths[0]);
    return true;
  });
  handle('extensions:removeSkill', (directory) =>
    extensionManager().removeSkill(z.string().parse(directory)),
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
  handle('agent:settings', () => (host.config ? publicConfig(host.config) : undefined));
  handle('agent:configured', () => !!host.config && host.config.provider !== 'demo');
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
    const task = host.tasks.create(snapshot.prompt, workspaceRoot ?? 'chat://hikari/imported');
    task.title = snapshot.title;
    task.chat = !workspaceRoot || undefined;
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
  handle('agent:start', (prompt, isolated, parentTaskId, options, attachmentIds) =>
    host.start(
      z.string().trim().min(1).max(24000).parse(prompt),
      !host.config ||
        host.config.provider === 'demo' ||
        (parentTaskId && host.tasks.get(id.parse(parentTaskId)).demo)
        ? demoWorkspace.root
        : (workspaceRoot ?? ''),
      z.boolean().default(false).parse(isolated),
      id.optional().parse(parentTaskId),
      options === undefined ? undefined : runOptionsSchema.parse(options),
      z.array(id).max(attachmentLimits.maxFiles).default([]).parse(attachmentIds),
    ),
  );
  handle('agent:list', () => host.tasks.list());
  const inactive = (taskId: unknown) => {
    const task = host.tasks.get(id.parse(taskId));
    if (
      host.runners.has(task.id) ||
      !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)
    )
      throw new Error('Finish or cancel this task before managing it');
    return task;
  };
  handle('agent:rename', (taskId, title) => {
    const task = host.tasks.get(id.parse(taskId));
    task.title = z.string().trim().min(1).max(120).parse(title);
    task.updatedAt = new Date().toISOString();
    persistence.task(task);
  });
  handle('agent:archive', (taskId, archived) => {
    const task = inactive(taskId);
    task.archived = z.boolean().parse(archived);
    persistence.task(task);
  });
  handle('agent:remove', async (taskId) => {
    const task = inactive(taskId);
    if (task.worktree) throw new Error('Archive the isolated worktree before deleting its task');
    for (const child of host.tasks.list())
      if (child.parentTaskId === task.id) {
        child.parentTaskId = task.parentTaskId;
        persistence.task(child);
      }
    await persistence.repository.remove('tasks', 'local', task.id);
    await persistence.repository.remove('changes', 'local', task.id);
    await persistence.repository.remove('messages', 'local', `checkpoint:${task.id}`);
    for (const event of task.events)
      await persistence.repository.remove('events', 'local', event.id);
    await persistence.repository.remove('workspaces', 'local', `demo:${task.id}`);
    host.tasks.remove(task.id);
    host.changes.delete(task.id);
    host.demos.delete(task.id);
  });
  handle('agent:export', async (taskId) => {
    const task = host.tasks.get(id.parse(taskId));
    const result = await dialog.showSaveDialog(window, {
      defaultPath: 'hikari-conversation.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return false;
    const final = task.events
      .slice()
      .reverse()
      .find((event) => event.type === 'agent.completed');
    const content = {
      format: 'hikari-conversation',
      version: 1,
      title: task.title,
      prompt: task.prompt,
      answer: typeof final?.data.text === 'string' ? final.data.text : '',
      status: task.status,
      plan: task.plan,
      summary: task.runSummary,
      attachments: task.attachments?.map((item) => ({
        name: item.name,
        kind: item.kind,
        mimeType: item.mimeType,
      })),
    };
    let encoded = JSON.stringify(redact(content), null, 2);
    for (const profile of host.profiles.values())
      for (const secret of [profile.apiKey, profile.embeddings?.apiKey])
        if (secret && secret.length >= 6) encoded = encoded.split(secret).join('[REDACTED]');
    await writeFile(result.filePath, encoded, { mode: 0o600 });
    return true;
  });
  handle('agent:import', async () => {
    const selected = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [{ name: 'Hikari conversation', extensions: ['json'] }],
    });
    const filename = selected.filePaths[0];
    if (selected.canceled || !filename) return undefined;
    if ((await stat(filename)).size > 2000000) throw new Error('Conversation exceeds 2 MB');
    const value = z
      .object({
        format: z.literal('hikari-conversation'),
        version: z.literal(1),
        title: z.string().max(120),
        prompt: z.string().max(24000),
        answer: z.string().max(1000000),
      })
      .parse(JSON.parse(await readFile(filename, 'utf8')));
    const task = host.tasks.create(value.prompt, workspaceRoot ?? `chat://hikari/imported`);
    task.title = value.title;
    task.imported = true;
    task.chat = !workspaceRoot || undefined;
    const bus = new (await import('@hikari/agent-runtime')).EventBus(task);
    bus.emit('agent.state', { state: 'planning' });
    bus.emit('agent.state', { state: 'thinking' });
    bus.emit('agent.completed', { text: value.answer });
    bus.emit('agent.state', { state: 'completed' });
    persistence.task(task);
    return task;
  });
  handle('agent:editMemory', (scope, entry) =>
    host.editMemory(
      z.string().min(1).max(4000).parse(scope),
      z
        .object({
          id,
          title: z.string().min(1).max(150),
          content: z.string().min(1).max(4000),
          source: z.string().max(500).optional(),
          expiresAt: z.string().datetime().optional(),
        })
        .parse(entry),
    ),
  );
  handle('agent:grants', () =>
    persistence.repository.listSync('grants', 'local').map((record) => ({
      id: record.id,
      description: String(
        redact(
          (record.data as { description?: string }).description ?? 'Legacy persistent permission',
        ),
      ),
      updatedAt: record.updatedAt,
    })),
  );
  handle('agent:revokeGrant', async (value) => {
    await persistence.repository.remove(
      'grants',
      'local',
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(value),
    );
    host.revokeSessionGrants();
  });
  const deliveries = new Map<string, WorktreeDelivery>();
  const worktreeTask = (value: unknown) => {
    const task = inactive(value);
    if (!task.worktree || task.demo || task.chat)
      throw new Error('This task has no isolated worktree');
    if (
      host.tasks.list().some((item) => item.worktree === task.worktree && host.runners.has(item.id))
    )
      throw new Error('Finish all tasks using this worktree before delivery or cleanup');
    return task;
  };
  handle('worktree:preview', async (taskId) => {
    const task = worktreeTask(taskId);
    const delivery = new WorktreeDelivery(task.workspace);
    deliveries.set(task.id, delivery);
    const worktreeId = path.basename(task.worktree!);
    return delivery.preview(worktreeId);
  });
  handle('worktree:apply', async (taskId, previewId) => {
    const task = worktreeTask(taskId),
      delivery = deliveries.get(task.id);
    if (!delivery) throw new Error('Preview delivery first');
    if (
      host.tasks
        .list()
        .some(
          (item) =>
            (item.worktree ?? item.workspace) === task.workspace && host.runners.has(item.id),
        )
    )
      throw new Error('Finish tasks in the original workspace before applying delivery');
    const changes = new FileChangeService(task.workspace, { emit() {} });
    await delivery.apply(id.parse(previewId), changes);
    persistence.save('changes', `delivery:${task.id}`, changes.history);
    deliveries.delete(task.id);
  });
  handle('worktree:restore', async (value) => {
    const task = inactive(value);
    if (!task.worktreeArchive) throw new Error('This task has no archived worktree');
    const target = await new WorktreeService(task.workspace).restore(task.worktreeArchive);
    const archive = task.worktreeArchive;
    for (const item of host.tasks.list())
      if (item.worktreeArchive === archive) {
        item.worktree = target;
        item.worktreeArchive = undefined;
        persistence.task(item);
      }
  });
  handle('worktree:undoDelivery', async (value) => {
    const task = inactive(value);
    if (
      host.tasks
        .list()
        .some(
          (item) =>
            !item.worktree && item.workspace === task.workspace && host.runners.has(item.id),
        )
    )
      throw new Error('Finish workspace tasks before undoing delivered changes');
    const history = persistence.get('changes', `delivery:${task.id}`)?.data as
      | import('@hikari/tools').Change[]
      | undefined;
    if (!history?.length) throw new Error('No delivered changes to undo');
    const service = new FileChangeService(task.workspace, { emit() {} });
    service.history.push(...history);
    for (const change of service.history.slice().reverse())
      if (!change.undone) {
        await service.undo(change.id);
        persistence.save('changes', `delivery:${task.id}`, service.history);
      }
  });
  handle('worktree:archive', async (taskId) => {
    const task = worktreeTask(taskId),
      target = task.worktree!;
    if (host.tasks.list().some((item) => item.worktree === target && item.status === 'interrupted'))
      throw new Error('Cancel or finish interrupted worktree tasks before archiving');
    const archive = await new WorktreeService(task.workspace).archive(path.basename(target));
    for (const item of host.tasks.list())
      if (item.worktree === target) {
        item.worktree = undefined;
        item.worktreeArchive = archive;
        item.resumable = false;
        persistence.task(item);
        const checkpoint = persistence.checkpoints.load(item.id);
        if (checkpoint) persistence.checkpoints.save(item.id, { ...checkpoint, done: true });
      }
    return archive;
  });

  handle('agent:control', (taskId, action) =>
    host.control(id.parse(taskId), z.enum(['pause', 'resume', 'cancel', 'retry']).parse(action)),
  );
  handle('agent:answer', (taskId, questionId, answer) =>
    host.answer(
      id.parse(taskId),
      id.parse(questionId),
      z.string().trim().min(1).max(12000).parse(answer),
    ),
  );
  handle('agent:input', (taskId, text) =>
    host.input(id.parse(taskId), z.string().trim().min(1).max(12000).parse(text)),
  );
  handle('agent:memories', (scope) => host.memory(z.string().min(1).max(4000).parse(scope)));
  handle('agent:forget', (scope, entry) =>
    host.forget(z.string().min(1).max(4000).parse(scope), id.parse(entry)),
  );
  handle('agent:models', async (value) => {
    const config = modelConfigSchema.parse(value);
    const saved = config.profileId ? host.profiles.get(config.profileId) : host.config;
    if (!config.apiKey && saved?.provider === config.provider && saved.baseUrl === config.baseUrl)
      config.apiKey = saved.apiKey;
    return listModels(config);
  });
  handle('agent:test', async (value) => {
    const config = modelConfigSchema.parse(value);
    const saved = config.profileId ? host.profiles.get(config.profileId) : host.config;
    if (!config.apiKey && saved?.provider === config.provider && saved.baseUrl === config.baseUrl)
      config.apiKey = saved.apiKey;
    if (config.provider === 'demo') return { text: 'Offline mode', tools: false };
    const provider = createModelProvider({
      ...config,
      tokenParameter:
        config.tokenParameter ??
        (config.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'),
    });
    const response = await provider.chat({
      messages: [
        {
          role: 'user',
          content:
            'Call connection_check with {"ok":true}. This is a connection and tool compatibility check; do not perform any external actions.',
        },
      ],
      tools: [
        {
          name: 'connection_check',
          description: 'Confirm connection',
          parameters: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      ],
      maxOutputTokens: 256,
      signal: AbortSignal.timeout(30000),
    });
    return {
      text: response.text,
      tools: response.toolCalls.some((call) => call.name === 'connection_check'),
    };
  });
  handle('agent:approve', (taskId, requestId, decision) =>
    host.approve(
      id.parse(taskId),
      z.string().parse(requestId),
      z.enum(['once', 'session', 'always', 'deny']).parse(decision),
    ),
  );
  handle('git:diff', (taskId) => {
    if (taskId && host.tasks.get(id.parse(taskId)).chat) return '';
    if (taskId && host.tasks.get(id.parse(taskId)).demo)
      return (
        host.demos
          .get(id.parse(taskId))
          ?.changes.map(
            (change) => `[Simulated] ${change.path}\n${change.before}\n→\n${change.after}`,
          )
          .join('\n') ?? ''
      );
    return new GitService(
      taskId
        ? (host.tasks.get(id.parse(taskId)).worktree ?? host.tasks.get(id.parse(taskId)).workspace)
        : root(),
    ).diff();
  });
  handle(
    'git:changes',
    (taskId) =>
      host.demos.get(id.parse(taskId))?.changes ??
      host.changes.get(id.parse(taskId))?.history ??
      [],
  );
  handle('git:review', async (taskId, changeId, action) => {
    const task = host.tasks.get(id.parse(taskId));
    if (!['completed', 'failed', 'cancelled', 'paused'].includes(task.status))
      throw new Error('Pause or finish the task before reviewing changes');
    const operation = z.enum(['accept', 'reject', 'undo']).parse(action);
    if (task.demo) {
      host.reviewDemo(task, id.parse(changeId), operation);
      host.notifyReview(task, id.parse(changeId), operation);
      return;
    }
    const changes = host.changes.get(task.id);
    if (!changes) throw new Error('No changes');
    if (operation === 'accept') changes.accept(id.parse(changeId));
    else await changes.undo(id.parse(changeId));
    persistence.task(task, undefined, changes.history);
    host.notifyReview(task, id.parse(changeId), operation);
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
    const result = await dialog.showMessageBox(window, {
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
  const url = process.env.ELECTRON_RENDERER_URL;
  if (url === 'http://127.0.0.1:5173') void window.loadURL(url);
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'));
});
app.on('before-quit', () => {
  host.close();
  terminals.close();
});
app.on('window-all-closed', () => app.quit());
