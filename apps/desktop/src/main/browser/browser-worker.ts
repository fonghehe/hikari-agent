import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';

/** Isolated Electron process: no application IPC, profiles, credentials or task database. */
export async function startBrowserWorker() {
  const directory = process.env.HIKARI_BROWSER_DATA;
  if (!directory || !path.isAbsolute(directory))
    throw new Error('Missing isolated browser profile');
  app.setPath('userData', directory);
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', '0');
  app.commandLine.appendSwitch('no-first-run');
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, respond) =>
    respond(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!['http:', 'https:', 'about:'].includes(new URL(url).protocol)) event.preventDefault();
  });
  await window.loadURL('about:blank');
  app.on('window-all-closed', () => app.quit());
}
