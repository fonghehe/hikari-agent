import { expect, it } from 'vitest';
import { windowsTerminalEnvironment } from '../apps/desktop/src/main/windows-terminal';

it('builds a case-insensitive, ordinally sorted Windows environment including TERM', () => {
  const base = {
    PATH: 'bin',
    SystemRoot: 'C:\\Windows',
    COMSPEC: 'cmd.exe',
    TERM: 'xterm-256color',
  };
  const source = {
    AppData: 'roaming',
    LOCALAPPDATA: 'local',
    userprofile: 'profile',
    Temp: 'tmp',
    TMP: 'tmp',
    PSModulePath: 'modules',
    PATHEXT: '.EXE;.CMD',
    ProgramFiles: 'programs',
    OPENAI_API_KEY: 'private',
    GITHUB_TOKEN: 'private',
    NODE_OPTIONS: '--inspect',
  };
  const env = windowsTerminalEnvironment(base, source);
  expect(env).toEqual({
    ...base,
    APPDATA: 'roaming',
    LOCALAPPDATA: 'local',
    USERPROFILE: 'profile',
    TEMP: 'tmp',
    TMP: 'tmp',
    PSModulePath: 'modules',
    PATHEXT: '.EXE;.CMD',
    ProgramFiles: 'programs',
  });
  const keys = Object.keys(env).map((key) => key.toUpperCase());
  expect(keys).toEqual([...keys].sort());
  expect(keys).toHaveLength(new Set(keys).size);
  expect(JSON.stringify(env)).not.toContain('private');
  expect(env).not.toHaveProperty('NODE_OPTIONS');
  expect(base).toEqual({
    PATH: 'bin',
    SystemRoot: 'C:\\Windows',
    COMSPEC: 'cmd.exe',
    TERM: 'xterm-256color',
  });
});

it('does not invent paths for unset Windows variables', () => {
  expect(windowsTerminalEnvironment({ TERM: 'xterm-256color' }, {})).toEqual({
    TERM: 'xterm-256color',
  });
});
