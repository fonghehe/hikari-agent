import { afterEach, expect, it, vi } from 'vitest';

const pty = vi.hoisted(() => ({ write: vi.fn(), kill: vi.fn() }));
vi.mock('../apps/desktop/node_modules/node-pty', () => ({
  spawn: () => ({ ...pty, onData: () => {}, onExit: () => {} }),
}));
import { TerminalSessions } from '../apps/desktop/src/main/terminal';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('delivers one unmodified Win32 Enter press and release without keyboard-layout synthesis', () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const sessions = new TerminalSessions(() => {});
  const id = sessions.create(process.cwd());
  sessions.write(id, 'Write-Output 42\r');
  const stream = pty.write.mock.calls[0]![0] as string;
  const [text, ...sequences] = stream.split('\x1b[');
  expect(text).toBe('Write-Output 42');
  // Decode the Microsoft KEY_EVENT_RECORD wire format rather than echoing the encoder.
  const keys = sequences.map((sequence) => {
    expect(sequence.endsWith('_')).toBe(true);
    const [virtualKey, scanCode, unicode, keyDown, modifiers, repeat] = sequence
      .slice(0, -1)
      .split(';')
      .map(Number);
    return { virtualKey, scanCode, unicode, keyDown, modifiers, repeat };
  });
  expect(keys).toEqual([
    { virtualKey: 13, scanCode: 28, unicode: 13, keyDown: 1, modifiers: 0, repeat: 1 },
    { virtualKey: 13, scanCode: 28, unicode: 13, keyDown: 0, modifiers: 0, repeat: 1 },
  ]);
  const protocol = '\x1b[1;1R\x1b[?1;2c\x1b[A';
  sessions.write(id, protocol);
  expect(pty.write).toHaveBeenLastCalledWith(protocol);
  sessions.kill(id);
  expect(() => sessions.write(id, '\r')).toThrow('Terminal closed');
});

it.each(['darwin', 'linux'])('preserves POSIX input bytes on %s', (platform) => {
  vi.stubGlobal('process', { ...process, platform });
  const sessions = new TerminalSessions(() => {});
  const id = sessions.create(process.cwd());
  const input = "printf 'verified\\n'\r\x1b[A";
  sessions.write(id, input);
  expect(pty.write).toHaveBeenLastCalledWith(input);
  sessions.close();
});
