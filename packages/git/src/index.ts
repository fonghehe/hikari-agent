export * from './worktree';
import { lstat, readFile } from 'node:fs/promises';
import { AgentError, sensitivePath, redactText } from '@hikari/agent-core';
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
  async diff(agentSafe = false) {
    // A new repository has no HEAD, but its staged and unstaged changes still matter.
    const head = (
      await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, [0, 1])
    ).trim();
    const names = (
      (await this.run(['ls-files', '-z'])) +
      (head ? await this.run(['ls-tree', '-r', '--name-only', '-z', 'HEAD']) : '')
    )
      .split('\0')
      .filter(Boolean);
    const exclusions = [...new Set(names.filter(sensitivePath))].map(
      (name) => `:(exclude,literal)${name}`,
    );
    if (agentSafe) {
      const changed = (
        head
          ? await this.run(['diff', '--name-only', '-z', 'HEAD', '--'])
          : (await this.run(['diff', '--cached', '--name-only', '-z', '--'])) +
            (await this.run(['diff', '--name-only', '-z', '--']))
      )
        .split('\0')
        .filter(Boolean);
      for (const name of new Set(changed)) {
        if (sensitivePath(name)) continue;
        const file = await this.sandbox.resolve(this.root, name);
        const info = await lstat(file).catch(() => undefined);
        if (info && (!info.isFile() || info.size > 512000)) {
          exclusions.push(`:(exclude,literal)${name}`);
          continue;
        }
        const current = await readFile(file, 'utf8').catch(() => '');
        const previous = head
          ? await this.run(['show', `HEAD:${name}`], undefined, [0, 128]).catch(
              () => '[external review required]',
            )
          : '';
        if (
          current.length > 512000 ||
          redactText(current) !== current ||
          redactText(previous) !== previous ||
          previous === '[external review required]'
        )
          exclusions.push(`:(exclude,literal)${name}`);
      }
    }
    const tracked = head
      ? await this.run(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.', ...exclusions])
      : (await this.run([
          'diff',
          '--cached',
          '--no-ext-diff',
          '--no-textconv',
          '--',
          '.',
          ...exclusions,
        ])) +
        (await this.run(['diff', '--no-ext-diff', '--no-textconv', '--', '.', ...exclusions]));
    const untracked = (await this.run(['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter((name) => !!name && !sensitivePath(name));
    const patches = [tracked];
    for (const name of untracked.slice(0, 200)) {
      if (name.startsWith('.agent/')) continue;
      const file = await this.sandbox.resolve(this.root, name);
      const info = await lstat(file);
      if (!info.isFile() || info.size > (agentSafe ? 512000 : 2000000)) {
        patches.push(`\nUntracked file: ${name} (${info.size} bytes; external review required)\n`);
        continue;
      }
      if (agentSafe) {
        const content = await readFile(file, 'utf8');
        if (content.length > 512000 || redactText(content) !== content) continue;
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
