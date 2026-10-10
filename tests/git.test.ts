import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess, LogicalSandboxProvider } from '../packages/sandbox/src';
import { GitService } from '../packages/git/src';
it('creates an isolated worktree from HEAD without copying dirty files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-git-'));
  const sandbox = new LogicalSandboxProvider();
  const git = (args: string[]) =>
    runProcess('git', args, {
      cwd: root,
      env: sandbox.environment(),
      signal: new AbortController().signal,
    });
  try {
    await git(['init']);
    await writeFile(path.join(root, 'a.txt'), 'committed');
    await git(['add', 'a.txt']);
    const committed = await git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'test fixture',
    ]);
    expect(committed.exitCode).toBe(0);
    await writeFile(path.join(root, 'a.txt'), 'dirty');
    const worktree = await new GitService(root).worktree('fixture-task');
    expect(await readFile(path.join(worktree, 'a.txt'), 'utf8')).toBe('committed');
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('dirty');
    await expect(new GitService(root).worktree('../escape')).rejects.toThrow('Invalid task');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('shows staged and untracked changes in a repository without HEAD', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-unborn-'));
  try {
    const git = new GitService(root);
    await git.run(['init']);
    await writeFile(path.join(root, 'staged.txt'), 'staged contents\n');
    await git.run(['add', 'staged.txt']);
    await writeFile(path.join(root, 'new.txt'), 'untracked contents\n');
    const diff = await git.diff();
    expect(diff).toContain('staged contents');
    expect(diff).toContain('untracked contents');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('copies uncommitted worktree state, delivers guarded patches and preserves cleanup archives', async () => {
  const { WorktreeService } = await import('../packages/git/src');
  const { WorktreeDelivery, FileChangeService } = await import('../packages/tools/src');
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-delivery-'));
  try {
    const git = new GitService(root);
    await git.run(['init']);
    await writeFile(path.join(root, 'a.txt'), 'committed\n');
    await git.run(['add', 'a.txt']);
    await git.run([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'fixture',
    ]);
    await writeFile(path.join(root, 'a.txt'), 'existing user edit\n');
    await writeFile(path.join(root, 'untracked.txt'), 'keep untracked\n');
    const service = new WorktreeService(root),
      target = await service.create('working-task', 'working-tree');
    expect(service.root).toBe(await realpath(root));
    const baseline = await service.baseline('working-task');
    expect(baseline.root).toBe(service.root);
    expect(baseline.target).toBe(path.join(service.root, '.agent', 'worktrees', 'working-task'));
    expect(await readFile(path.join(target, 'a.txt'), 'utf8')).toBe('existing user edit\n');
    expect(await readFile(path.join(target, 'untracked.txt'), 'utf8')).toBe('keep untracked\n');
    await writeFile(path.join(target, 'a.txt'), 'existing user edit\nagent addition\n');
    const delivery = new WorktreeDelivery(root);
    const preview = await delivery.preview('working-task');
    expect(preview.applicable).toBe(true);
    await writeFile(path.join(root, 'a.txt'), 'concurrent user edit\n');
    await expect(
      delivery.apply(preview.id, new FileChangeService(root, { emit() {} })),
    ).rejects.toThrow('File changed');
    expect((await delivery.preview('working-task')).files[0]?.conflict).toContain('changed');
    await writeFile(path.join(root, 'a.txt'), 'existing user edit\n');
    const current = await delivery.preview('working-task');
    const changes = new FileChangeService(root, { emit() {} });
    await delivery.apply(current.id, changes);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toContain('agent addition');
    await changes.undo(changes.history[0]!.id);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('existing user edit\n');
    const archive = await service.archive('working-task');
    await expect(readFile(path.join(target, 'a.txt'))).rejects.toThrow();
    expect(await readFile(archive, 'utf8')).toContain('untracked.txt');
    expect(await service.restore(archive)).toBe(target);
    expect(await readFile(path.join(target, 'a.txt'), 'utf8')).toContain('agent addition');
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('existing user edit\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('refuses delivery over pre-existing edits when the worktree starts from HEAD', async () => {
  const { WorktreeService } = await import('../packages/git/src');
  const { WorktreeDelivery } = await import('../packages/tools/src');
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-head-conflict-'));
  try {
    const git = new GitService(root);
    await git.run(['init']);
    await writeFile(path.join(root, 'a.txt'), 'base\n');
    await git.run(['add', 'a.txt']);
    await git.run([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'fixture',
    ]);
    await writeFile(path.join(root, 'a.txt'), 'user change\n');
    const target = await new WorktreeService(root).create('head-task');
    await writeFile(path.join(target, 'a.txt'), 'agent change\n');
    const preview = await new WorktreeDelivery(root).preview('head-task');
    expect(preview.applicable).toBe(false);
    expect(preview.files[0]?.conflict).toContain('Pre-existing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
