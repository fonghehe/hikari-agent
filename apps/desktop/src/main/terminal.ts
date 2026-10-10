import { randomUUID } from 'node:crypto';
import { spawn, type IPty } from 'node-pty';
import { LogicalSandboxProvider } from '@hikari/sandbox';
export class TerminalSessions {
  private sessions = new Map<string, IPty>();
  private sandbox = new LogicalSandboxProvider();
  constructor(private publish: (event: { id: string; data: string; exited?: boolean }) => void) {}
  create(cwd: string) {
    if (this.sessions.size >= 3) throw new Error('Maximum 3 terminal sessions');
    const id = randomUUID();
    const shell =
      process.platform === 'win32'
        ? 'powershell.exe'
        : process.platform === 'darwin'
          ? '/bin/zsh'
          : '/bin/bash';
    const terminal = spawn(shell, [], {
      cwd,
      env: { ...this.sandbox.environment(), TERM: 'xterm-256color' },
      cols: 80,
      rows: 24,
      name: 'xterm-256color',
      // The system ConPTY backend races its console-list helper against kill().
      // The bundled backend closes the input pipe and pseudoconsole directly.
      useConptyDll: process.platform === 'win32',
    });
    this.sessions.set(id, terminal);
    terminal.onData((data) => this.publish({ id, data: data.slice(0, 65536) }));
    terminal.onExit(() => {
      this.sessions.delete(id);
      this.publish({ id, data: '\r\n[Terminal exited]\r\n', exited: true });
    });
    return id;
  }
  private get(id: string) {
    const terminal = this.sessions.get(id);
    if (!terminal) throw new Error('Terminal closed');
    return terminal;
  }
  write(id: string, data: string) {
    // ConPTY's legacy CR path synthesizes a key through the console keyboard map.
    // Send VK_RETURN directly so PSReadLine receives Enter, including on CI desktops.
    // Win32 input records are accepted by ConPTY alongside ordinary VT input.
    const input =
      process.platform === 'win32'
        ? data.replaceAll('\r', '\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_')
        : data;
    this.get(id).write(input);
  }
  resize(id: string, cols: number, rows: number) {
    this.get(id).resize(cols, rows);
  }
  kill(id: string) {
    this.sessions.get(id)?.kill();
    this.sessions.delete(id);
  }
  close() {
    for (const id of this.sessions.keys()) this.kill(id);
  }
}
