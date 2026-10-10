import { test, expect } from '@playwright/test';
import { TerminalSessions } from '../../apps/desktop/src/main/terminal';
test('PTY executes input, resizes and terminates a native shell', async () => {
  let output = '';
  const sessions = new TerminalSessions((event) => {
    output += event.data;
  });
  try {
    const id = sessions.create(process.cwd());
    sessions.resize(id, 100, 30);
    sessions.write(
      id,
      process.platform === 'win32'
        ? "Write-Output ('FORGE_PTY_' + 'VERIFIED')\r"
        : "printf 'FORGE_PTY_%s\\n' VERIFIED\r",
    );
    await expect.poll(() => output).toContain('FORGE_PTY_VERIFIED');
    sessions.kill(id);
    expect(() => sessions.write(id, 'x')).toThrow('Terminal closed');
  } finally {
    sessions.close();
  }
});
