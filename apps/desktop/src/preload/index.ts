import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopAPI,
  DesktopInvokeChannel,
  DesktopInvokeArgs,
  DesktopInvokeResult,
} from '@hikari/shared';

function invoke<Channel extends DesktopInvokeChannel>(
  channel: Channel,
  ...args: DesktopInvokeArgs<Channel>
): DesktopInvokeResult<Channel> {
  return ipcRenderer.invoke(channel, ...args) as DesktopInvokeResult<Channel>;
}
const api: DesktopAPI = {
  sections: {
    list: () => invoke('sections:list'),
    create: (name) => invoke('sections:create', name),
    rename: (name, next) => invoke('sections:rename', name, next),
    remove: (name) => invoke('sections:remove', name),
    markRead: (name) => invoke('sections:markRead', name),
    archive: (name) => invoke('sections:archive', name),
  },
  platform: {
    list: (workspaceRoot) => invoke('platform:list', workspaceRoot),
    schedule: (input, workspaceRoot) => invoke('platform:schedule', input, workspaceRoot),
    updateSchedule: (id, enabled, workspaceRoot) =>
      invoke('platform:updateSchedule', id, enabled, workspaceRoot),
    importPlugin: (update, workspaceRoot) => invoke('platform:importPlugin', update, workspaceRoot),
    removePlugin: (name, workspaceRoot) => invoke('platform:removePlugin', name, workspaceRoot),
    registry: (source, workspaceRoot) => invoke('platform:registry', source, workspaceRoot),
    installRegistry: (entry, update, workspaceRoot) =>
      invoke('platform:installRegistry', entry, update, workspaceRoot),
    configure: (kind, entries, workspaceRoot) =>
      invoke('platform:configure', kind, entries, workspaceRoot),
    remoteStart: (host, port, workspaceRoot) =>
      invoke('platform:remoteStart', host, port, workspaceRoot),
    remoteStop: (workspaceRoot) => invoke('platform:remoteStop', workspaceRoot),
    timeline: (taskId) => invoke('platform:timeline', taskId),
    previewRewind: (taskId, checkpointId) => invoke('platform:previewRewind', taskId, checkpointId),
    rewind: (taskId, checkpointId, mode) => invoke('platform:rewind', taskId, checkpointId, mode),
  },
  attachments: {
    pick: () => invoke('attachments:pick'),
    import: (files) => invoke('attachments:import', files),
    read: (id) => invoke('attachments:read', id),
  },
  extensions: {
    list: (workspaceRoot) => invoke('extensions:list', workspaceRoot),
    server: (name, config, workspaceRoot) =>
      invoke('extensions:server', name, config, workspaceRoot),
    importSkill: (workspaceRoot) => invoke('extensions:importSkill', workspaceRoot),
    removeSkill: (directory, workspaceRoot) =>
      invoke('extensions:removeSkill', directory, workspaceRoot),
  },
  updates: {
    status: () => invoke('updates:status'),
    check: () => invoke('updates:check'),
    download: () => invoke('updates:download'),
    install: () => invoke('updates:install'),
  },
  clipboard: { write: (text) => invoke('clipboard:write', text) },
  maintenance: {
    status: () => invoke('maintenance:status'),
    backup: () => invoke('maintenance:backup'),
    restore: () => invoke('maintenance:restore'),
    cancelRestore: () => invoke('maintenance:cancelRestore'),
    diagnostics: () => invoke('maintenance:diagnostics'),
    prune: () => invoke('maintenance:prune'),
  },
  external: { open: (url) => invoke('external:open', url) },
  preferences: {
    get: () => invoke('preferences:get'),
    set: (value) => invoke('preferences:set', value),
  },
  workspace: {
    pick: (kind) => invoke('workspace:pick', kind),
    open: (kind) => invoke('workspace:open', kind),
    add: (input) => invoke('workspace:add', input),
    rename: (root, name) => invoke('workspace:rename', root, name),
    organize: (root, options) => invoke('workspace:organize', root, options),
    archive: (root) => invoke('workspace:archive', root),
    remove: (root) => invoke('workspace:remove', root),
    clear: () => invoke('workspace:clear'),
    recent: () => invoke('workspace:recent'),
    select: (root) => invoke('workspace:select', root),
    read: (path, taskId) => invoke('workspace:read', path, taskId),
    snapshot: (taskId) => invoke('workspace:snapshot', taskId),
  },
  agent: {
    profiles: () => invoke('agent:profiles'),
    activateProfile: (id) => invoke('agent:activateProfile', id),
    removeProfile: (id) => invoke('agent:removeProfile', id),
    configured: () => invoke('agent:configured'),
    settings: () => invoke('agent:settings'),
    configure: (config) => invoke('agent:configure', config),
    start: (prompt, isolated, parentTaskId, options, attachmentIds, section) =>
      invoke('agent:start', prompt, isolated, parentTaskId, options, attachmentIds, section),
    list: () => invoke('agent:list'),
    rename: (id, title) => invoke('agent:rename', id, title),
    organize: (id, options) => invoke('agent:organize', id, options),
    fork: (id, title, isolated) => invoke('agent:fork', id, title, isolated),
    openWindow: (id) => invoke('agent:openWindow', id),
    copy: (id, format) => invoke('agent:copy', id, format),
    openExternal: (id, target) => invoke('agent:openExternal', id, target),
    archive: (id, archived) => invoke('agent:archive', id, archived),
    remove: (id) => invoke('agent:remove', id),
    export: (id) => invoke('agent:export', id),
    import: () => invoke('agent:import'),
    editMemory: (scope, entry) => invoke('agent:editMemory', scope, entry),
    grants: () => invoke('agent:grants'),
    revokeGrant: (id) => invoke('agent:revokeGrant', id),
    control: (id, action) => invoke('agent:control', id, action),
    answer: (taskId, questionId, answer) => invoke('agent:answer', taskId, questionId, answer),
    input: (taskId, text) => invoke('agent:input', taskId, text),
    memories: (scope) => invoke('agent:memories', scope),
    forget: (scope, id) => invoke('agent:forget', scope, id),
    models: (config) => invoke('agent:models', config),
    test: (config) => invoke('agent:test', config),
    approve: (taskId, id, decision) => invoke('agent:approve', taskId, id, decision),
    subscribe: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, data: Parameters<typeof listener>[0]) =>
        listener(data);
      ipcRenderer.on('agent:event', handler);
      return () => {
        ipcRenderer.removeListener('agent:event', handler);
      };
    },
  },
  git: {
    diff: (taskId) => invoke('git:diff', taskId),
    changes: (taskId) => invoke('git:changes', taskId),
    review: (taskId, changeId, action) => invoke('git:review', taskId, changeId, action),
  },
  worktree: {
    preview: (taskId) => invoke('worktree:preview', taskId),
    apply: (taskId, previewId) => invoke('worktree:apply', taskId, previewId),
    archive: (taskId) => invoke('worktree:archive', taskId),
    restore: (taskId) => invoke('worktree:restore', taskId),
    undoDelivery: (taskId) => invoke('worktree:undoDelivery', taskId),
  },
  sync: {
    status: () => invoke('sync:status'),
    connect: (input) => invoke('sync:connect', input),
    push: (taskId) => invoke('sync:push', taskId),
    pull: () => invoke('sync:pull'),
    logout: () => invoke('sync:logout'),
    import: (id) => invoke('sync:import', id),
  },
  browser: { preview: (taskId) => invoke('browser:preview', taskId) },
  terminal: {
    create: (taskId) => invoke('terminal:create', taskId),
    write: (id, data) => invoke('terminal:write', id, data),
    resize: (id, cols, rows) => invoke('terminal:resize', id, cols, rows),
    kill: (id) => invoke('terminal:kill', id),
    subscribe: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, data: Parameters<typeof listener>[0]) =>
        listener(data);
      ipcRenderer.on('terminal:data', handler);
      return () => {
        ipcRenderer.removeListener('terminal:data', handler);
      };
    },
  },
};
contextBridge.exposeInMainWorld('hikari', api);
// Backward-compatible bridge for integrations written before the product rename.
contextBridge.exposeInMainWorld('forge', api);
