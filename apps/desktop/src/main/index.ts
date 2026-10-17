import { mkdirSync } from 'node:fs';
import { app, ipcMain, nativeTheme, type BrowserWindow } from 'electron';
import { preferencesSchema } from '@hikari/shared';
import { LocalPersistence } from './persistence';
import { TaskHost } from './task-host';
import { TerminalSessions } from './terminal';
import { desktopDataPath, migrateDesktopDatabase } from './data-path';
import { createDesktopWindow, loadDesktopWindow } from './window';
import { createIpcRouter } from './ipc/router';
import { registerDesktopHandlers } from './ipc';
import { applyPendingRestore } from './data-maintenance';
// Use the current database name; migrate legacy data through SQLite before opening it.
const dataPath = desktopDataPath(
  app.getPath('appData'),
  app.getPath('userData'),
  process.env.HIKARI_DATA_DIR || process.env.FORGE_DATA_DIR,
);
mkdirSync(dataPath.directory, { recursive: true, mode: 0o700 });
app.setPath('userData', dataPath.directory);
app.setName('Hikari');
app.setAppUserModelId('dev.hikari.agent');
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
let disposeIpc: (() => void) | undefined;
let window: BrowserWindow;
const windows = new Set<BrowserWindow>();
app.on('second-instance', () => {
  const target = [...windows].find((owner) => !owner.isDestroyed());
  if (target?.isMinimized()) target.restore();
  target?.show();
  target?.focus();
});
const host = new TaskHost((event) => {
  for (const owner of windows)
    if (!owner.isDestroyed()) owner.webContents.send('agent:event', event);
});
const terminals = new TerminalSessions((event) => {
  for (const owner of windows)
    if (!owner.isDestroyed()) owner.webContents.send('terminal:data', event);
});
app.whenReady().then(async () => {
  if (!primaryInstance) return;
  await applyPendingRestore(dataPath.database);
  await migrateDesktopDatabase(dataPath);
  const persistence = new LocalPersistence(dataPath.database);
  host.initialize(persistence);
  const storedPreferences = preferencesSchema.safeParse(
    persistence.get('model_configs', 'app-preferences')?.data ?? {},
  );
  const preferences = storedPreferences.success
    ? storedPreferences.data
    : preferencesSchema.parse({});
  nativeTheme.themeSource = preferences.theme;
  window = createDesktopWindow();
  const router = createIpcRouter(ipcMain, window);
  windows.add(window);
  const roots = new Map<BrowserWindow, string>();
  const track = (owner: BrowserWindow) => {
    owner.on('closed', () => {
      windows.delete(owner);
      roots.delete(owner);
      router.removeWindow(owner);
    });
  };
  track(window);
  disposeIpc = router.dispose;
  registerDesktopHandlers(
    router.handle,
    {
      get window() {
        return router.currentWindow;
      },
      host,
      persistence,
      terminals,
      workspaceState: {
        get root() {
          return roots.get(router.currentWindow);
        },
        set root(value: string | undefined) {
          if (value) roots.set(router.currentWindow, value);
          else roots.delete(router.currentWindow);
        },
        require() {
          if (!this.root) throw new Error('Open a workspace first');
          return this.root;
        },
      },
      async openTaskWindow(taskId) {
        const owner = createDesktopWindow();
        windows.add(owner);
        router.addWindow(owner);
        track(owner);
        try {
          await loadDesktopWindow(owner, taskId);
        } catch (error) {
          owner.destroy();
          throw error;
        }
      },
    },
    preferences,
  );
  await loadDesktopWindow(window);
});
app.on('before-quit', () => {
  disposeIpc?.();
  host.close();
  terminals.close();
});
app.on('window-all-closed', () => app.quit());
