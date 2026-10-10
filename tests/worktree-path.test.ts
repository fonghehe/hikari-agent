import { it, expect } from 'vitest';
import path from 'node:path';
import { sameWorktreePath } from '../packages/git/src/worktree';

it('accepts equivalent Windows drive casing and separators without accepting another project', () => {
  expect(
    sameWorktreePath(
      'd:/a/project/.agent/worktrees/task',
      'D:\\a\\project\\.agent\\worktrees\\task',
      path.win32,
    ),
  ).toBe(true);
  expect(
    sameWorktreePath(
      'D:\\a\\other\\.agent\\worktrees\\task',
      'D:\\a\\project\\.agent\\worktrees\\task',
      path.win32,
    ),
  ).toBe(false);
  expect(
    sameWorktreePath(
      'D:\\a\\project\\.agent\\worktrees\\task-extra',
      'D:\\a\\project\\.agent\\worktrees\\task',
      path.win32,
    ),
  ).toBe(false);
  expect(sameWorktreePath('E:\\a\\project', 'D:\\a\\project', path.win32)).toBe(false);
  expect(sameWorktreePath('D:\\a\\symlink\\..\\project', 'D:\\a\\project', path.win32)).toBe(false);
});

it('preserves POSIX case sensitivity and rejects invalid or relative manifest paths', () => {
  expect(sameWorktreePath('/workspace/Project', '/workspace/project', path.posix)).toBe(false);
  expect(sameWorktreePath('/workspace/project', '/workspace/project', path.posix)).toBe(true);
  expect(sameWorktreePath('/workspace/symlink/../project', '/workspace/project', path.posix)).toBe(
    false,
  );
  for (const value of [undefined, null, 42, {}, '.', 'project'])
    expect(sameWorktreePath(value, '/workspace/project', path.posix)).toBe(false);
});
