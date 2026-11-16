import { it, expect } from 'vitest';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanupTargets } from '../../scripts/clean.mjs';

it('limits cleanup to generated directories and refuses symlink escapes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-clean-'));
  try {
    const targets = (
      await Promise.all(['build', 'reports', 'cache'].map((scope) => cleanupTargets(root, scope)))
    ).flat();
    expect(targets.every((target) => target.startsWith(root + path.sep))).toBe(true);
    expect(
      targets.some((target) => /releases|node_modules|\.agent(?:s)?(?:\/|$)/.test(target)),
    ).toBe(false);
    await expect(cleanupTargets(root, '../')).rejects.toThrow('Choose');
    await mkdir(path.join(root, 'outside'));
    await symlink(
      path.join(root, 'outside'),
      path.join(root, '.artifacts'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(cleanupTargets(root, 'reports')).rejects.toThrow('symbolic link');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
