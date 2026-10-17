import { afterEach, expect, it, vi } from 'vitest';

const pty = vi.hoisted(() => ({ write: vi.fn(), kill: vi.fn(), spawn: vi.fn(), onData: vi.fn() }));
vi.mock('../apps/desktop/node_modules/node-pty', () => ({
  spawn: (...args: unknown[]) => {
    pty.spawn(...args);
    return { ...pty, onExit: () => {} };
  },
}));
import { TerminalSessions } from '../apps/desktop/src/main/terminal';
import { terminalEnvironment } from '../apps/desktop/src/main/terminal-environment';

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
    env: expect.objectContaining({
      TERM: 'xterm-256color',
      LANG: expect.stringMatching(/utf-?8/i),
      LC_CTYPE: expect.stringMatching(/utf-?8/i),
    }),
    encoding: 'utf8',
    cols: 80,
    rows: 24,
    name: 'xterm-256color',
    useConptyDll: false,
  });
  sessions.write(id, input);
  expect(pty.write).toHaveBeenLastCalledWith(input);
  sessions.close();
});

it('selects a UTF-8 POSIX locale without inheriting unrelated credentials', () => {
  expect(terminalEnvironment({}, {}, 'darwin')).toMatchObject({
    LANG: 'en_US.UTF-8',
    LC_CTYPE: 'en_US.UTF-8',
  });
  expect(terminalEnvironment({ LANG: 'C' }, {}, 'linux')).toMatchObject({
    LANG: 'C.UTF-8',
    LC_CTYPE: 'C.UTF-8',
  });
  const environment = terminalEnvironment(
    { LANG: 'en_US.UTF-8' },
    { LC_CTYPE: 'ja_JP.UTF-8', PRIVATE_KEY: 'fixture' },
    'darwin',
  );
  expect(environment.LC_CTYPE).toBe('ja_JP.UTF-8');
  expect(environment.PRIVATE_KEY).toBeUndefined();
});

it('forwards complete Unicode output chunks without cutting off terminal control sequences', () => {
  const publish = vi.fn();
  const sessions = new TerminalSessions(publish);
  try {
    const id = sessions.create(process.cwd());
    const output = '中文'.repeat(40000) + '\x1b[0mEND\r\n';
    pty.onData.mock.calls[0]![0](output);
    expect(publish).toHaveBeenCalledWith({ id, data: output });
  } finally {
    sessions.close();
  }
});
