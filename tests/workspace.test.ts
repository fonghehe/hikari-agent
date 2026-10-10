import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openWorkspace, readWorkspaceFile } from '../apps/desktop/src/main/workspace';
describe('workspace boundary', () => {
  it('opens a real directory and blocks symlinks outside it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forge-'));
    try {
      await writeFile(path.join(root, 'hello.ts'), 'export {}');
      await symlink(
        tmpdir(),
        path.join(root, 'outside'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect((await openWorkspace(root)).files).toContain('hello.ts');
      expect(await readWorkspaceFile(root, 'hello.ts')).toBe('export {}');
      await expect(readWorkspaceFile(root, 'outside')).rejects.toThrow('outside workspace');
      await expect(readWorkspaceFile(root, '..')).rejects.toThrow('outside workspace');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
