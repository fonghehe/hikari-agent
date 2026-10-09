export * from './worktree';
import { lstat } from 'node:fs/promises';
import { AgentError } from '@hikari/agent-core';
import { LogicalSandboxProvider, runProcess } from '@hikari/sandbox';
export class GitService {
  constructor(
    readonly root: string,
    private sandbox = new LogicalSandboxProvider(),
  ) {}
  async run(args: string[], signal: AbortSignal = new AbortController().signal, accepted = [0]) {
    const result = await runProcess(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.pager=cat',
        ...args,
      ],
      {
        cwd: this.root,
        env: { ...this.sandbox.environment(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
        signal,
        timeoutMs: 30000,
      },
    );
    if (!accepted.includes(result.exitCode)) throw new AgentError('GIT_ERROR', result.output);
    return result.output;
  }
  status() {
    return this.run(['status', '--short']);
  }
  async diff() {
    // A new repository has no HEAD, but its staged and unstaged changes still matter.
    const head = (
      await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, [0, 1])
    ).trim();
    const tracked = head
      ? await this.run(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'])
      : (await this.run(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--'])) +
        (await this.run(['diff', '--no-ext-diff', '--no-textconv', '--']));
    const untracked = (await this.run(['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean);
    const patches = [tracked];
    for (const name of untracked.slice(0, 200)) {
      if (name.startsWith('.agent/')) continue;
      const file = await this.sandbox.resolve(this.root, name);
      const info = await lstat(file);
      if (!info.isFile() || info.size > 2000000) {
        patches.push(`\nUntracked file: ${name} (${info.size} bytes; external review required)\n`);
        continue;
      }
      patches.push(
        await this.run(
          ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file],
          undefined,
          [0, 1],
        ),
      );
    }
    if (untracked.length > 200)
      patches.push(
        '\nAdditional untracked files omitted; use git_status for the full inventory.\n',
      );
    return patches.join('\n');
  }
  log() {
    return this.run(['log', '-20', '--oneline']);
  }
  branch() {
    return this.run(['branch', '--show-current']);
  }
  checkout(branch: string) {
    if (!/^[a-zA-Z0-9][\w/.-]*$/.test(branch) || branch.includes('..'))
      throw new AgentError('INVALID_BRANCH', 'Invalid branch');
    return this.run(['checkout', branch]);
  }
  commit(message: string) {
    if (!message.trim()) throw new AgentError('EMPTY_COMMIT', 'Commit message required');
    return this.run(['commit', '-m', message]);
  }
  async worktree(taskId: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(taskId)) throw new AgentError('INVALID_TASK_ID', 'Invalid task ID');
    const target = await this.sandbox.resolve(this.root, `.agent/worktrees/${taskId}`);
    await this.run(['worktree', 'add', '-b', `hikari/${taskId}`, target, 'HEAD']);
    return target;
  }
}
