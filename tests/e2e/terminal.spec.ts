import { test, expect } from '@playwright/test';
import { TerminalSessions } from '../../apps/desktop/src/main/terminal';
import headless from '@xterm/headless';
test('PTY executes input, resizes and terminates a native shell', async () => {
  let output = '';
  const terminal = new headless.Terminal({ cols: 80, rows: 24 });
  const sessions = new TerminalSessions((event) => {
    output += event.data;
    terminal.write(event.data);
  });
  let id: string;
  // A PTY consumer must answer cursor/device queries, just like the UI's xterm.
  const replies = terminal.onData((data) => sessions.write(id, data));
  try {
    id = sessions.create(process.cwd());
    if (process.platform === 'win32') await expect.poll(() => output).toMatch(/PS [^\r\n]*> /);
    terminal.resize(100, 30);
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
    replies.dispose();
    sessions.close();
    terminal.dispose();
    // Preserve control sequences so a Windows failure shows the actual handshake.
    await test.info().attach('pty-output', {
      body: JSON.stringify(output),
      contentType: 'application/json',
    });
  }
});
