import { realpath, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '@hikari/shared';
export async function safePath(root: string, relative: string) {
  const base = await realpath(root);
  const target = await realpath(path.resolve(base, relative));
  const rel = path.relative(base, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new Error('Path is outside workspace');
  return target;
}
export async function openWorkspace(root: string): Promise<Workspace> {
  const base = await realpath(root);
  const entries = await readdir(base, { withFileTypes: true });
  return {
    root: base,
    name: path.basename(base),
    files: entries
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name + (e.isDirectory() ? '/' : '')),
  };
}
export async function readWorkspaceFile(root: string, file: string) {
  const target = await safePath(root, file);
  const info = await stat(target);
  if (!info.isFile() || info.size > 512000)
    throw new Error('Select a text file smaller than 512 KB');
  return readFile(target, 'utf8');
}
