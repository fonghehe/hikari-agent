import { z } from 'zod';
import type { Task } from '@hikari/agent-core';
import type { LocalPersistence } from './persistence';
import { WorkspaceProjects } from './projects';

const nameSchema = z.string().trim().min(1).max(60);
const key = (name: string) => name.normalize('NFKC').toLowerCase();

/** Sections organize navigation only; removing one never removes saved conversations. */
export class SidebarSections {
  private projects: WorkspaceProjects;
  constructor(
    private persistence: LocalPersistence,
    private tasks: () => Task[],
    private running: (id: string) => boolean = () => false,
  ) {
    this.projects = new WorkspaceProjects(persistence, tasks, running);
  }
  async list(): Promise<string[]> {
    const saved = z
      .array(nameSchema)
      .safeParse(this.persistence.get('model_configs', 'sidebar-sections')?.data);
    const names = [
      ...(saved.success ? saved.data : []),
      ...(await this.projects.list()).map((project) => project.section),
      ...this.tasks().map((task) => task.navigation?.section),
    ];
    const unique = new Map<string, string>();
    for (const name of names) if (name && !unique.has(key(name))) unique.set(key(name), name);
    return [...unique.values()];
  }
  private save(names: string[]) {
    this.persistence.save('model_configs', 'sidebar-sections', names);
  }
  async create(input: string): Promise<void> {
    const name = nameSchema.parse(input);
    const names = await this.list();
    if (names.some((item) => key(item) === key(name)))
      throw new Error('A section with this name already exists');
    this.save([...names, name]);
  }
  async rename(input: string, replacement: string): Promise<void> {
    const name = nameSchema.parse(input),
      next = nameSchema.parse(replacement),
      names = await this.list();
    if (!names.includes(name)) throw new Error('Section is not registered');
    if (names.some((item) => item !== name && key(item) === key(next)))
      throw new Error('A section with this name already exists');
    await this.moveMembers(name, next);
    this.save(names.map((item) => (item === name ? next : item)));
  }
  async remove(input: string): Promise<void> {
    const name = nameSchema.parse(input),
      names = await this.list();
    await this.moveMembers(name, null);
    this.save(names.filter((item) => item !== name));
  }
  private async moveMembers(name: string, next: string | null): Promise<void> {
    for (const project of await this.projects.list())
      if (project.section === name) await this.projects.organize(project.root, { section: next });
    for (const task of this.tasks())
      if (task.navigation?.section === name) {
        task.navigation = { ...task.navigation, section: next ?? undefined };
        this.persistence.task(task);
      }
  }
  private async members(input: string): Promise<Task[]> {
    const name = nameSchema.parse(input);
    const roots = new Set(
      (await this.projects.list())
        .filter((project) => !project.hidden && !project.pinned && project.section === name)
        .flatMap((project) => [project.root, ...(project.aliases ?? [])]),
    );
    return this.tasks().filter(
      (task) =>
        !task.archived &&
        !task.navigation?.pinned &&
        (task.navigation?.section === name ||
          (!task.navigation?.section && !task.chat && !task.demo && roots.has(task.workspace))),
    );
  }
  async markRead(name: string): Promise<void> {
    for (const task of await this.members(name))
      if (task.navigation?.unread) {
        task.navigation = { ...task.navigation, unread: false };
        this.persistence.task(task);
      }
  }
  async archive(name: string): Promise<number> {
    const members = await this.members(name);
    if (
      members.some(
        (task) =>
          this.running(task.id) ||
          !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status),
      )
    )
      throw new Error('Finish or cancel active section tasks before archiving conversations');
    for (const task of members) {
      task.archived = true;
      this.persistence.task(task);
    }
    return members.length;
  }
}
