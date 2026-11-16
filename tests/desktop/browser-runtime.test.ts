import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createDesktopBrowser } from '../../apps/desktop/src/main/browser/browser-runtime';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { connectOverCDP: vi.fn() } }));

it.each([
  { code: 1, signal: null, status: '1' },
  { code: null, signal: 'SIGABRT', status: 'SIGABRT' },
])(
  'reports browser startup failure $status with stderr and removes the profile',
  async ({ code, signal, status }) => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    let directory = '';
    vi.mocked(spawn).mockImplementation((_command, _args, options) => {
      directory = options!.env!.HIKARI_BROWSER_DATA!;
      queueMicrotask(() => {
        child.stderr.write('Chromium sandbox startup denied');
        child.exitCode = code;
        child.signalCode = signal as NodeJS.Signals | null;
        child.emit('exit', code, signal);
      });
      return child as unknown as ChildProcess;
    });
    await expect(createDesktopBrowser()).rejects.toThrow(
      `Isolated browser exited ${status}: Chromium sandbox startup denied`,
    );
    expect(child.kill).not.toHaveBeenCalled();
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
