import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalPersistence } from '../apps/desktop/src/main/persistence';
import { WorkspaceProjects } from '../apps/desktop/src/main/projects';
import { TaskManager } from '../packages/agent-runtime/src';
import { resolveProjectRoot } from '../apps/desktop/src/main/ipc/context';
import { groupProjectTasks } from '../apps/desktop/src/renderer/project-navigation';

let data: string;
let root: string;
let alias: string;
let file: string;
let persistence: LocalPersistence;
let tasks: TaskManager;
let projects: WorkspaceProjects;
beforeEach(async () => {
  data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-projects-')));
  root = path.join(data, 'website');
  alias = path.join(data, 'linked-website');
  file = path.join(root, 'README.md');
  await mkdir(root);
  await writeFile(file, '# Project fixture');
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  persistence = new LocalPersistence(path.join(data, 'projects.sqlite'));
  tasks = new TaskManager();
  projects = new WorkspaceProjects(persistence, () => tasks.list());
});
afterEach(async () => {
  await persistence.close();
  await rm(data, { recursive: true, force: true });
});

it('deduplicates canonical directories, aliases, trailing separators and file imports', async () => {
  const legacy = tasks.create('Legacy alias question', alias);
  persistence.save('workspaces', alias, { root: alias, name: 'Legacy website' });
  await projects.add({ path: root });
  await projects.add({ path: alias + path.sep });
  await projects.add({ path: file });
  const list = await projects.list();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ root, name: 'Legacy website', hidden: false });
  expect(list[0]?.aliases).toContain(alias);
  const grouped = groupProjectTasks([legacy], list);
  expect(grouped.projects).toHaveLength(1);
  expect(grouped.projects[0]?.tasks).toEqual([legacy]);
});

it('keeps edited names when reopening a directory or importing one of its files', async () => {
  await projects.add({ path: root });
  await projects.rename(alias, '  Client website  ');
  expect((await projects.add({ path: file })).name).toBe('Client website');
  expect((await projects.add({ path: alias })).name).toBe('Client website');
  expect((await projects.list())[0]?.name).toBe('Client website');
});

it('hides projects without deleting history and reconnects saved records after restart and reimport', async () => {
  const task = tasks.create('Preserved project question', alias);
  task.status = 'completed';
  persistence.task(task);
  const before = persistence.get('tasks', task.id);
  await projects.add({ path: root, name: 'Retained project' });
  await projects.remove(alias);
  expect(groupProjectTasks([task], await projects.list()).projects).toEqual([]);
  expect(persistence.get('tasks', task.id)).toEqual(before);
  const filename = persistence.repository.filename;
  await persistence.close();
  persistence = new LocalPersistence(filename);
  projects = new WorkspaceProjects(persistence, () => persistence.tasks());
  expect((await projects.list())[0]?.hidden).toBe(true);
  expect(groupProjectTasks(persistence.tasks(), await projects.list()).projects).toEqual([]);
  await projects.add({ path: file });
  const grouped = groupProjectTasks(persistence.tasks(), await projects.list());
  expect(grouped.projects).toHaveLength(1);
  expect(grouped.projects[0]?.name).toBe('Retained project');
  expect(grouped.projects[0]?.tasks[0]?.id).toBe(task.id);
  expect(persistence.get('tasks', task.id)).toEqual(before);
});

it('keeps explicit hidden state ahead of legacy duplicate records', async () => {
  persistence.save('workspaces', root, { root, name: 'Original' });
  persistence.save('workspaces', alias, { root: alias, name: 'Duplicate alias' });
  tasks.create('Original question', root);
  tasks.create('Alias question', alias);
  await projects.remove(alias);
  const list = await projects.list();
  expect(list).toHaveLength(1);
  expect(list[0]?.hidden).toBe(true);
  expect(groupProjectTasks(tasks.list(), list).projects).toEqual([]);
});

it('keeps different directories with the same display name as separate projects', async () => {
  const other = path.join(data, 'other', 'website');
  await mkdir(other, { recursive: true });
  await projects.add({ path: root });
  await projects.add({ path: other });
  expect((await projects.list()).map((project) => project.root).sort()).toEqual(
    [root, other].sort(),
  );
});

it('rejects invalid paths and empty names without losing existing project metadata', async () => {
  await projects.add({ path: root, name: 'Keep this name' });
  await expect(projects.add({ path: 'relative/path' })).rejects.toThrow('absolute');
  await expect(projects.add({ path: path.join(data, 'missing') })).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(projects.rename(root, '   ')).rejects.toThrow();
  await expect(projects.remove(path.join(data, 'unknown'))).rejects.toThrow('not registered');
  expect((await projects.list())[0]?.name).toBe('Keep this name');
});

it('includes projects beyond the database page boundary', async () => {
  for (let index = 0; index < 501; index++) {
    const directory = path.join(data, `legacy-${index}`);
    persistence.save('workspaces', directory, { root: directory, name: `Legacy ${index}` });
  }
  expect(await projects.list()).toHaveLength(501);
});

it('persists pinning and sections across reopening and a registry restart', async () => {
  await projects.add({ path: root });
  await projects.organize(alias, { pinned: true });
  await projects.add({ path: file });
  expect((await projects.list())[0]?.pinned).toBe(true);
  await projects.organize(root, { section: 'Work' });
  projects = new WorkspaceProjects(persistence, () => tasks.list());
  expect((await projects.list())[0]).toMatchObject({ pinned: false, section: 'Work' });
  await projects.remove(root);
  await projects.add({ path: root });
  expect((await projects.list())[0]).toMatchObject({ section: 'Work', hidden: false });
  await projects.organize(root, { section: null });
  expect((await projects.list())[0]?.section).toBeUndefined();
});

it('archives only the selected project conversations, including legacy aliases', async () => {
  const first = tasks.create('Original', root);
  const second = tasks.create('Alias', alias);
  const other = tasks.create('Other project', '/another-project');
  for (const task of tasks.list()) {
    task.status = 'completed';
    persistence.task(task);
  }
  await projects.add({ path: root });
  expect(await projects.archive(root)).toBe(2);
  expect(first.archived).toBe(true);
  expect(second.archived).toBe(true);
  expect(other.archived).toBeUndefined();
  expect(persistence.tasks()).toHaveLength(3);
  expect(await projects.archive(alias)).toBe(0);
});

it('rejects bulk archiving atomically when any project conversation is still active', async () => {
  const completed = tasks.create('Completed', root);
  completed.status = 'completed';
  const running = tasks.create('Running', root);
  running.status = 'thinking';
  await projects.add({ path: root });
  await expect(projects.archive(root)).rejects.toThrow('active project tasks');
  expect(completed.archived).toBeUndefined();
  expect(running.archived).toBeUndefined();
});

it('resolves explicit settings roots without changing the selected project and rejects unknown roots', async () => {
  await projects.add({ path: root });
  const other = path.join(data, 'other');
  await mkdir(other);
  await projects.add({ path: other });
  const context = {
    persistence,
    host: { tasks },
    workspaceState: {
      root: other,
      require() {
        return this.root;
      },
    },
  };
  expect(await resolveProjectRoot(context, alias)).toBe(root);
  expect(context.workspaceState.root).toBe(other);
  expect(await resolveProjectRoot(context)).toBe(other);
  await expect(resolveProjectRoot(context, data)).rejects.toThrow('Project is not registered');
});
