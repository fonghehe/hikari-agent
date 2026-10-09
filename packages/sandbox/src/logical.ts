import path from 'node:path';
import { realpath, lstat } from 'node:fs/promises';
import { AgentError } from '@hikari/agent-core';
export interface SandboxProvider {
  resolve(root: string, target: string, write?: boolean): Promise<string>;
  validateCommand(command: string, args: string[]): void;
  environment(): NodeJS.ProcessEnv;
  launch?(command: string, args: string[], cwd: string): Promise<import('./native').ProcessLaunch>;
}
export class LogicalSandboxProvider implements SandboxProvider {
  async resolve(root: string, target: string, write = false) {
    const base = await realpath(root);
    const candidate = path.resolve(base, target);
    const assert = (p: string) => {
      const rel = path.relative(base, p);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
        throw new AgentError('PATH_ESCAPE', 'Path is outside workspace');
      if (write && rel.split(path.sep).some((part) => part === '.git' || part === '.agent'))
        throw new AgentError('PROTECTED_PATH', 'Agent metadata and Git internals are protected');
      const parts = rel.split(path.sep);
      if (parts[0] === '.agent' && ['runs', 'evals'].includes(parts[1] ?? ''))
        throw new AgentError('PROTECTED_PATH', 'Private run and evaluation data is protected');
    };
    assert(candidate);
    let cursor = candidate;
    while (true) {
      try {
        await lstat(cursor);
        const actual = await realpath(cursor);
        assert(actual);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw error;
        cursor = parent;
      }
    }
    return candidate;
  }
  validateCommand(command: string, args: string[]) {
    if (
      !/^(?:[a-zA-Z]:[\\/])?[\w./\\ -]+$/.test(command) ||
      /^(sudo|su|doas|shutdown|reboot|mkfs|diskutil|dd)$/i.test(path.basename(command))
    )
      throw new AgentError('COMMAND_DENIED', 'System command denied');
    if (
      path.basename(command) === 'rm' &&
      args.some((arg) => arg.includes('r')) &&
      args.some((arg) => arg.includes('f'))
    )
      throw new AgentError('COMMAND_DENIED', 'Recursive forced deletion denied');
  }
  environment() {
    return Object.fromEntries(
      ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SystemRoot', 'COMSPEC'].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]!]] : [],
      ),
    );
  }
}
