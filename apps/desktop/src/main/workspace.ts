import { realpath, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace, WorkspaceProject } from '@hikari/shared';

/** Resolve aliases once per navigation refresh, without rewriting saved task identities. */
export async function listWorkspaceProjects(
  recent: WorkspaceProject[],
  taskRoots: string[],
): Promise<WorkspaceProject[]> {
  const sources = new Map<string, WorkspaceProject>();
  for (const project of recent) if (!sources.has(project.root)) sources.set(project.root, project);
  for (const root of taskRoots)
    if (!sources.has(root)) sources.set(root, { root, name: path.basename(root) });
  const resolved = await Promise.all(
    [...sources.values()].map(async (project) => ({
      ...project,
      canonical: await realpath(project.root).catch(() => project.root),
    })),
  );
  const groups = new Map<string, WorkspaceProject & { aliases: string[] }>();
  for (const project of resolved) {
    let group = groups.get(project.canonical);
    if (!group) {
      group = {
        root: project.canonical,
        name: project.name,
        hidden: project.hidden,
        pinned: project.pinned,
        section: project.section,
        aliases: [],
      };
      groups.set(group.root, group);
    }
    for (const alias of [project.root, ...(project.aliases ?? [])])
      if (!group.aliases.includes(alias)) group.aliases.push(alias);
  }
  return [...groups.values()];
}
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
