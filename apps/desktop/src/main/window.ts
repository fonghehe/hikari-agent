import path from 'node:path';
import { app, BrowserWindow, nativeTheme, nativeImage, session } from 'electron';

export function createDesktopWindow() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icons/hikari.png')
    : path.join(app.getAppPath(), 'resources/icons/hikari.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) app.dock?.setIcon(icon);
  const window = new BrowserWindow({
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
  return window;
}

export function loadDesktopWindow(window: BrowserWindow, taskId?: string) {
  const url = process.env.ELECTRON_RENDERER_URL;
  const query: Record<string, string> = taskId ? { task: taskId } : {};
  return url === 'http://127.0.0.1:5173'
    ? window.loadURL(`${url}${taskId ? `?${new URLSearchParams(query)}` : ''}`)
    : window.loadFile(path.join(__dirname, '../renderer/index.html'), { query });
}
