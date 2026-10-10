// node-pty serializes this object directly into CreateProcessW's environment block.
// Windows requires that block to be sorted without regard to case or locale.
export function windowsTerminalEnvironment(
  base: NodeJS.ProcessEnv,
  source = process.env,
): NodeJS.ProcessEnv {
  const values = new Map<string, [string, string | undefined]>(
    Object.entries(base).map(([key, value]) => [key.toUpperCase(), [key, value]]),
  );
  const inherited = new Map(
    Object.entries(source).map(([key, value]) => [key.toUpperCase(), value]),
  );
  // PSModulePath lets PowerShell autoload cmdlets such as Write-Output. Preserve
  // standard user/temp locations too, without inheriting model credentials.
  for (const key of [
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'TEMP',
    'TMP',
    'PATHEXT',
    'PSModulePath',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'windir',
    'HOMEDRIVE',
    'HOMEPATH',
  ]) {
    const value = inherited.get(key.toUpperCase());
    if (value !== undefined) values.set(key.toUpperCase(), [key, value]);
  }
  return Object.fromEntries(
    [...values.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, entry]) => entry),
  );
}
