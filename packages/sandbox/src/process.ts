import { spawn } from 'node:child_process';
import { AgentError } from '@hikari/agent-core';
export interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs?: number;
  maxOutput?: number;
  stdin?: string;
  stdout?: (chunk: string) => void;
}
export function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions,
): Promise<{ output: string; exitCode: number }> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let output = '';
    let failure: Error | undefined;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill();
      } catch {
        /* already exited */
      }
      killTimer = setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }, 800);
      killTimer.unref();
    };
    const abort = () => {
      failure = new AgentError('CANCELLED', 'Command cancelled');
      kill();
    };
    const timeout = setTimeout(() => {
      failure = new AgentError('TIMEOUT', 'Command timed out');
      kill();
    }, options.timeoutMs ?? 30000);
    const consume = (chunk: Buffer) => {
      if (failure) return;
      const text = chunk.toString();
      if (Buffer.byteLength(output) + chunk.length > (options.maxOutput ?? 256000)) {
        failure = new AgentError('OUTPUT_LIMIT', 'Command exceeded output limit');
        kill();
        return;
      }
      output += text;
      options.stdout?.(text);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener('abort', abort);
    };
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin);
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      cleanup();
      if (failure) reject(failure);
      else resolve({ output, exitCode: code ?? 1 });
    });
  });
}
