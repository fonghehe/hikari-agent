import type { BrowserWindow, IpcMain } from 'electron';
import type { DesktopInvokeRawArgs } from '@hikari/shared';
import type { RegisterHandler } from './context';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface IpcRouter {
  handle: RegisterHandler;
  dispose(): void;
  addWindow(window: BrowserWindow): void;
  removeWindow(window: BrowserWindow): void;
  readonly currentWindow: BrowserWindow;
  readonly windows: ReadonlySet<BrowserWindow>;
}

/** All invoke handlers share one sender boundary and one lifetime. */
export function createIpcRouter(
  transport: Pick<IpcMain, 'handle' | 'removeHandler'>,
  window: BrowserWindow,
): IpcRouter {
  const channels = new Set<string>();
  const windows = new Set([window]);
  const senderWindow = new AsyncLocalStorage<BrowserWindow>();
  let disposed = false;
  const handle: RegisterHandler = (name, handler) => {
    if (disposed) throw new Error('IPC router is disposed');
    transport.handle(name, (event, ...args: unknown[]) => {
      const owner = [...windows].find(
        (item) => !item.isDestroyed() && event.sender === item.webContents,
      );
      if (!owner || event.senderFrame !== owner.webContents.mainFrame)
        throw new Error('Untrusted IPC sender');
      // Electron has no channel-specific types. Values remain unknown for validation.
      return senderWindow.run(owner, () => handler(...(args as DesktopInvokeRawArgs<typeof name>)));
    });
    channels.add(name);
  };
  return {
    handle,
    windows,
    get currentWindow() {
      return senderWindow.getStore() ?? [...windows].find((item) => !item.isDestroyed()) ?? window;
    },
    addWindow(owner) {
      if (disposed) throw new Error('IPC router is disposed');
      windows.add(owner);
    },
    removeWindow(owner) {
      windows.delete(owner);
    },
    dispose() {
      disposed = true;
      for (const name of channels) transport.removeHandler(name);
      channels.clear();
      windows.clear();
    },
  };
}
