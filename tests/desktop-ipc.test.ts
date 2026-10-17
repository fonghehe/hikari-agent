import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { createIpcRouter } from '../apps/desktop/src/main/ipc/router';

function fixture() {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const transport: Pick<IpcMain, 'handle' | 'removeHandler'> = {
    handle(name, listener) {
      if (handlers.has(name)) throw new Error('Duplicate handler');
      handlers.set(name, listener);
    },
    removeHandler(name) {
      handlers.delete(name);
    },
  };
  const contents = { mainFrame: {} };
  let destroyed = false;
  const window = {
    webContents: contents,
    isDestroyed: () => destroyed,
  } as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent;
  return {
    router: createIpcRouter(transport, window),
    handlers,
    event,
    destroy() {
      destroyed = true;
    },
  };
}

describe('desktop IPC boundary', () => {
  it('keeps each registered window as the owner across asynchronous handlers', async () => {
    const { router, handlers, event } = fixture();
    const other = {
      webContents: { mainFrame: {} },
      isDestroyed: () => false,
    } as unknown as BrowserWindow;
    router.addWindow(other);
    router.handle('workspace:read', async () => {
      const owner = router.currentWindow;
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(router.currentWindow).toBe(owner);
      return owner === other ? 'other' : 'primary';
    });
    const invoke = handlers.get('workspace:read')!;
    const otherEvent = {
      sender: other.webContents,
      senderFrame: other.webContents.mainFrame,
    } as IpcMainInvokeEvent;
    await expect(Promise.all([invoke(event), invoke(otherEvent)])).resolves.toEqual([
      'primary',
      'other',
    ]);
    router.removeWindow(other);
    expect(() => invoke(otherEvent)).toThrow('Untrusted IPC sender');
  });
  it('allows the owning main frame and rejects other windows and child frames', async () => {
    const { router, handlers, event } = fixture();
    const read = vi.fn(async (file: unknown) => `read:${String(file)}`);
    router.handle('workspace:read', read);
    const invoke = handlers.get('workspace:read')!;
    await expect(invoke(event, 'README.md')).resolves.toBe('read:README.md');
    for (const invalid of [
      { ...event, sender: {} },
      { ...event, senderFrame: {} },
      { ...event, senderFrame: null },
    ])
      expect(() => invoke(invalid as IpcMainInvokeEvent, 'secret')).toThrow('Untrusted IPC sender');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rejects late requests after the window is destroyed', () => {
    const { router, handlers, event, destroy } = fixture();
    const start = vi.fn();
    router.handle('agent:start', start);
    destroy();
    expect(() => handlers.get('agent:start')!(event, 'run')).toThrow('Untrusted IPC sender');
    expect(start).not.toHaveBeenCalled();
  });

  it('unregisters only owned channels and rejects registration after cleanup', () => {
    const { router, handlers } = fixture();
    handlers.set('another-service', () => 'keep');
    router.handle('agent:list', () => []);
    router.handle('preferences:get', () => ({ theme: 'system', language: 'en' }) as const);
    router.dispose();
    router.dispose();
    expect([...handlers.keys()]).toEqual(['another-service']);
    expect(() => router.handle('agent:list', () => [])).toThrow('IPC router is disposed');
  });
});
