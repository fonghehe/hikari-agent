import { afterEach, expect, it, vi } from 'vitest';

const pty = vi.hoisted(() => ({ write: vi.fn(), kill: vi.fn(), spawn: vi.fn() }));
vi.mock('../apps/desktop/node_modules/node-pty', () => ({
  spawn: (...args: unknown[]) => {
    pty.spawn(...args);
    return { ...pty, onData: () => {}, onExit: () => {} };
  },
}));
import { TerminalSessions } from '../apps/desktop/src/main/terminal';
import { LogicalSandboxProvider } from '../packages/sandbox/src/logical';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('preserves Windows input and terminal query replies without rewriting Enter', () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  vi.stubEnv('PSModulePath', 'C:\\fixture\\Modules');
  const sessions = new TerminalSessions(() => {});
  const id = sessions.create(process.cwd());
  const environment = (pty.spawn.mock.calls[0]![2] as { env: NodeJS.ProcessEnv }).env;
  expect(environment.PSModulePath).toBe('C:\\fixture\\Modules');
  const keys = Object.keys(environment).map((key) => key.toUpperCase());
  expect(keys).toEqual([...keys].sort());
  const input = 'Write-Output 42\r';
  sessions.write(id, input);
  expect(pty.write).toHaveBeenLastCalledWith(input);
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
  expect(pty.spawn).toHaveBeenCalledWith(platform === 'darwin' ? '/bin/zsh' : '/bin/bash', [], {
    cwd: process.cwd(),
    env: { ...new LogicalSandboxProvider().environment(), TERM: 'xterm-256color' },
    cols: 80,
    rows: 24,
    name: 'xterm-256color',
    useConptyDll: false,
  });
  sessions.write(id, input);
  expect(pty.write).toHaveBeenLastCalledWith(input);
  sessions.close();
});
