import { it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, symlink, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const identity = vi.hoisted(() => ({ alias: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  // Model Windows DOS short names: the JS sync resolver can retain the alias
  // while native sync and promise resolvers return the actual directory name.
  const resolve = ((...args: Parameters<typeof fs.realpathSync>) =>
    args[0] === identity.alias && !args[1]
      ? identity.alias
      : fs.realpathSync(...args)) as typeof fs.realpathSync;
  resolve.native = fs.realpathSync.native;
  return { ...fs, realpathSync: resolve };
});

import { GitService, WorktreeService } from '../packages/git/src';
import { WorktreeDelivery } from '../packages/tools/src';

it('uses native directory identity through worktree creation, delivery, archive and restore', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'hikari-worktree-alias-'));
  const project = path.join(base, 'project');
  const alias = path.join(base, 'alias');
  await mkdir(project);
  await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  identity.alias = alias;
  try {
    const git = new GitService(alias);
    await git.run(['init']);
    await writeFile(path.join(project, 'result.txt'), 'before\n');
    await git.run(['add', 'result.txt']);
    await git.run([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'fixture',
    ]);
    const service = new WorktreeService(alias);
    const target = await service.create('alias-task');
    await writeFile(path.join(target, 'result.txt'), 'after\n');
    expect((await new WorktreeDelivery(alias).preview('alias-task')).applicable).toBe(true);
    expect((await new WorktreeDelivery(project).preview('alias-task')).applicable).toBe(true);
    expect(service.root).toBe(await realpath(alias));
    const archive = await service.archive('alias-task');
    expect(await new WorktreeService(project).restore(archive)).toBe(target);
    expect(await readFile(path.join(target, 'result.txt'), 'utf8')).toBe('after\n');
    expect(await readFile(path.join(project, 'result.txt'), 'utf8')).toBe('before\n');
  } finally {
    identity.alias = '';
    await rm(base, { recursive: true, force: true });
  }
});
