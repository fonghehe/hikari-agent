import type { Task } from '@hikari/agent-core';
import type { WorkspaceProject } from '@hikari/shared';

export interface ProjectTaskGroup extends WorkspaceProject {
  tasks: Task[];
}

/** Manual order is independent of task updates; newly received chats remain discoverable. */
export function sortNavigationTasks(tasks: Task[], order?: readonly string[]): Task[] {
  const positions = new Map(order?.map((id, index) => [id, index]));
  return [...tasks].sort((a, b) => {
    if (order) {
      const difference = (positions.get(a.id) ?? -1) - (positions.get(b.id) ?? -1);
      if (difference) return difference;
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function moveNavigationTask(
  order: string[],
  id: string,
  target: string,
  after = false,
): string[] {
  if (id === target || !order.includes(id) || !order.includes(target)) return order;
  const next = order.filter((value) => value !== id);
  next.splice(next.indexOf(target) + Number(after), 0, id);
  return next;
}

/** Same names in separate directories need distinct labels, never merged histories. */
export function projectDisplayNames(projects: WorkspaceProject[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const project of projects) {
    const same = projects.filter((item) => item.name === project.name && !item.hidden);
    if (same.length < 2) {
      names.set(project.root, project.name);
      continue;
    }
    const parts = project.root
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .filter(Boolean);
    let depth = 2;
    while (
      depth < parts.length &&
      same.some(
        (item) =>
          item.root !== project.root &&
          item.root
            .replace(/[\\/]+$/, '')
            .split(/[\\/]/)
            .filter(Boolean)
            .slice(-depth)
            .join('/') === parts.slice(-depth).join('/'),
      )
    )
      depth++;
    names.set(
      project.root,
      `${project.name} · ${parts.slice(-depth, -1).join('/') || project.root}`,
    );
  }
  return names;
}

export function isProjectTask(task: Task): boolean {
  return !task.chat && !task.demo && !!task.workspace && !task.workspace.includes('://');
}

/** Group by the original project, including turns executed in an isolated worktree. */
export function groupProjectTasks(
  tasks: Task[],
  projects: WorkspaceProject[],
): { chats: Task[]; projects: ProjectTaskGroup[] } {
  const groups = new Map<string, ProjectTaskGroup>();
  const aliases = new Map<string, string>();
  for (const project of projects) groups.set(project.root, { ...project, tasks: [] });
  for (const project of projects)
    for (const alias of project.aliases ?? []) aliases.set(alias, project.root);
  const chats: Task[] = [];
  for (const task of tasks) {
    if (!isProjectTask(task)) {
      chats.push(task);
      continue;
    }
    const root = aliases.get(task.workspace) ?? task.workspace;
    let group = groups.get(root);
    if (!group) {
      group = {
        root: task.workspace,
        name:
          task.workspace
            .replace(/[\\/]+$/, '')
            .split(/[\\/]/)
            .at(-1) || task.workspace,
        tasks: [],
      };
      groups.set(task.workspace, group);
    }
    group.tasks.push(task);
  }
  return { chats, projects: [...groups.values()].filter((group) => !group.hidden) };
}
