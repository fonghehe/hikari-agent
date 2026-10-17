import { windowsTerminalEnvironment } from './windows-terminal';

export function terminalEnvironment(
  base: NodeJS.ProcessEnv,
  source = process.env,
  platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = {
    ...base,
    TERM: 'xterm-256color',
    TERM_PROGRAM: 'Hikari',
    COLORTERM: 'truecolor',
  };
  if (platform === 'win32') return windowsTerminalEnvironment(environment, source);
  // Desktop launches may have no locale. A POSIX shell then treats Chinese input
  // as separate bytes even though the PTY and xterm transport UTF-8 correctly.
  const locale =
    [source.LC_ALL, source.LC_CTYPE, base.LANG].find((value) => value && /utf-?8/i.test(value)) ??
    (platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8');
  return { ...environment, LANG: locale, LC_CTYPE: locale };
}
