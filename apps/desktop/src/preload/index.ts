import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '@hikari/shared';
const api: DesktopAPI = {
  attachments: {
    pick: () => ipcRenderer.invoke('attachments:pick'),
    import: (files) => ipcRenderer.invoke('attachments:import', files),
    read: (id) => ipcRenderer.invoke('attachments:read', id),
  },
  extensions: {
    list: () => ipcRenderer.invoke('extensions:list'),
    server: (name, config) => ipcRenderer.invoke('extensions:server', name, config),
    importSkill: () => ipcRenderer.invoke('extensions:importSkill'),
    removeSkill: (directory) => ipcRenderer.invoke('extensions:removeSkill', directory),
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
  },
  clipboard: { write: (text) => ipcRenderer.invoke('clipboard:write', text) },
  external: { open: (url) => ipcRenderer.invoke('external:open', url) },
  preferences: {
    get: () => ipcRenderer.invoke('preferences:get'),
    set: (value) => ipcRenderer.invoke('preferences:set', value),
  },
  workspace: {
    open: () => ipcRenderer.invoke('workspace:open'),
    recent: () => ipcRenderer.invoke('workspace:recent'),
    select: (root) => ipcRenderer.invoke('workspace:select', root),
    read: (path, taskId) => ipcRenderer.invoke('workspace:read', path, taskId),
    snapshot: (taskId) => ipcRenderer.invoke('workspace:snapshot', taskId),
  },
  agent: {
    profiles: () => ipcRenderer.invoke('agent:profiles'),
    activateProfile: (id) => ipcRenderer.invoke('agent:activateProfile', id),
    removeProfile: (id) => ipcRenderer.invoke('agent:removeProfile', id),
    configured: () => ipcRenderer.invoke('agent:configured'),
    settings: () => ipcRenderer.invoke('agent:settings'),
    configure: (config) => ipcRenderer.invoke('agent:configure', config),
    start: (prompt, isolated, parentTaskId, options, attachmentIds) =>
      ipcRenderer.invoke('agent:start', prompt, isolated, parentTaskId, options, attachmentIds),
    list: () => ipcRenderer.invoke('agent:list'),
    rename: (id, title) => ipcRenderer.invoke('agent:rename', id, title),
    archive: (id, archived) => ipcRenderer.invoke('agent:archive', id, archived),
    remove: (id) => ipcRenderer.invoke('agent:remove', id),
    export: (id) => ipcRenderer.invoke('agent:export', id),
    import: () => ipcRenderer.invoke('agent:import'),
    editMemory: (scope, entry) => ipcRenderer.invoke('agent:editMemory', scope, entry),
    grants: () => ipcRenderer.invoke('agent:grants'),
    revokeGrant: (id) => ipcRenderer.invoke('agent:revokeGrant', id),
    control: (id, action) => ipcRenderer.invoke('agent:control', id, action),
    answer: (taskId, questionId, answer) =>
      ipcRenderer.invoke('agent:answer', taskId, questionId, answer),
    input: (taskId, text) => ipcRenderer.invoke('agent:input', taskId, text),
    memories: (scope) => ipcRenderer.invoke('agent:memories', scope),
    forget: (scope, id) => ipcRenderer.invoke('agent:forget', scope, id),
    models: (config) => ipcRenderer.invoke('agent:models', config),
    test: (config) => ipcRenderer.invoke('agent:test', config),
    approve: (taskId, id, decision) => ipcRenderer.invoke('agent:approve', taskId, id, decision),
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
    diff: (taskId) => ipcRenderer.invoke('git:diff', taskId),
    changes: (taskId) => ipcRenderer.invoke('git:changes', taskId),
    review: (taskId, changeId, action) =>
      ipcRenderer.invoke('git:review', taskId, changeId, action),
  },
  worktree: {
    preview: (taskId) => ipcRenderer.invoke('worktree:preview', taskId),
    apply: (taskId, previewId) => ipcRenderer.invoke('worktree:apply', taskId, previewId),
    archive: (taskId) => ipcRenderer.invoke('worktree:archive', taskId),
    restore: (taskId) => ipcRenderer.invoke('worktree:restore', taskId),
    undoDelivery: (taskId) => ipcRenderer.invoke('worktree:undoDelivery', taskId),
  },
  sync: {
    status: () => ipcRenderer.invoke('sync:status'),
    connect: (input) => ipcRenderer.invoke('sync:connect', input),
    push: (taskId) => ipcRenderer.invoke('sync:push', taskId),
    pull: () => ipcRenderer.invoke('sync:pull'),
    logout: () => ipcRenderer.invoke('sync:logout'),
    import: (id) => ipcRenderer.invoke('sync:import', id),
  },
  browser: { preview: (taskId) => ipcRenderer.invoke('browser:preview', taskId) },
  terminal: {
    create: (taskId) => ipcRenderer.invoke('terminal:create', taskId),
    write: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('terminal:kill', id),
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
