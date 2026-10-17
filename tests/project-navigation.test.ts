import { expect, it } from 'vitest';
import { TaskManager } from '../packages/agent-runtime/src';
import {
  groupProjectTasks,
  projectDisplayNames,
  sortNavigationTasks,
  moveNavigationTask,
} from '../apps/desktop/src/renderer/project-navigation';

it('keeps project conversations under their source project, including follow-ups and worktrees', () => {
  const manager = new TaskManager();
  const first = manager.create('First project question', '/projects/alpha');
  const followUp = manager.create('Follow-up', '/projects/alpha');
  followUp.parentTaskId = first.id;
  followUp.worktree = '/tmp/isolated-alpha';
  const other = manager.create('Other project', '/projects/beta');
  const grouped = groupProjectTasks([followUp, other, first], []);
  expect(grouped.chats).toEqual([]);
  expect(grouped.projects.map((group) => [group.name, group.tasks.map((task) => task.id)])).toEqual(
    [
      ['alpha', [followUp.id, first.id]],
      ['beta', [other.id]],
    ],
  );
});

it('keeps conversation-only and demo tasks outside real projects', () => {
  const manager = new TaskManager();
  const chat = manager.create('Chat', 'chat://hikari/chat');
  chat.chat = true;
  const demo = manager.create('Demo', '/sample/project');
  demo.demo = true;
  const legacyChat = manager.create('Legacy chat', 'chat://hikari/imported');
  expect(groupProjectTasks([chat, demo, legacyChat], [])).toEqual({
    chats: [chat, demo, legacyChat],
    projects: [],
  });
});

it('includes empty recent projects and keeps identically named folders separate', () => {
  const manager = new TaskManager();
  const first = manager.create('First', '/work/website');
  const second = manager.create('Second', '/personal/website');
  const grouped = groupProjectTasks(
    [first, second],
    [
      { root: '/work/website', name: 'website' },
      { root: '/empty', name: 'Empty project' },
    ],
  );
  expect(grouped.projects.map((group) => [group.root, group.tasks.length])).toEqual([
    ['/work/website', 1],
    ['/empty', 0],
    ['/personal/website', 1],
  ]);
});

it('derives labels for Windows paths without changing project identity', () => {
  const task = new TaskManager().create('Windows project', 'C:\\work\\website');
  expect(groupProjectTasks([task], []).projects[0]).toMatchObject({
    root: task.workspace,
    name: 'website',
  });
});

it('distinguishes the two vue-h5-template projects by parent path without mixing conversations', () => {
  const projects = [
    { root: '/frontend/vue/turborepo-demo/vue-h5-template', name: 'vue-h5-template' },
    { root: '/frontend/vue/vue-h5-template/vue-h5-template', name: 'vue-h5-template' },
  ];
  const names = projectDisplayNames(projects);
  expect(names.get(projects[0]!.root)).toBe('vue-h5-template · turborepo-demo');
  expect(names.get(projects[1]!.root)).toBe('vue-h5-template · vue-h5-template');
  const manager = new TaskManager();
  const tasks = projects.map((project) => manager.create('Same title', project.root));
  const grouped = groupProjectTasks(tasks, projects);
  expect(grouped.projects.map((group) => group.tasks.length)).toEqual([1, 1]);
});

it('uses enough path segments to distinguish matching parent names and ignores hidden projects', () => {
  const projects = [
    { root: '/work/a/project', name: 'Project' },
    { root: '/home/a/project', name: 'Project' },
    { root: '/other/project', name: 'Unique' },
    { root: '/hidden/project', name: 'Unique', hidden: true },
  ];
  const names = projectDisplayNames(projects);
  expect(names.get(projects[0]!.root)).toBe('Project · work/a');
  expect(names.get(projects[1]!.root)).toBe('Project · home/a');
  expect(names.get(projects[2]!.root)).toBe('Unique');
});

it('keeps manual chat positions through updates and places new chats before the saved order', () => {
  const manager = new TaskManager();
  const a = manager.create('A', '/project');
  const b = manager.create('B', '/project');
  const c = manager.create('New', '/project');
  a.updatedAt = '2026-10-03T00:00:00Z';
  b.updatedAt = '2026-10-01T00:00:00Z';
  c.updatedAt = '2026-10-02T00:00:00Z';
  expect(sortNavigationTasks([a, b, c]).map((task) => task.title)).toEqual(['A', 'New', 'B']);
  expect(sortNavigationTasks([a, b, c], [b.id, a.id]).map((task) => task.title)).toEqual([
    'New',
    'B',
    'A',
  ]);
  expect(moveNavigationTask([a.id, b.id, c.id], c.id, a.id)).toEqual([c.id, a.id, b.id]);
  expect(moveNavigationTask([a.id, b.id, c.id], a.id, c.id, true)).toEqual([b.id, c.id, a.id]);
  expect(moveNavigationTask([a.id, b.id], 'missing', b.id)).toEqual([a.id, b.id]);
});
