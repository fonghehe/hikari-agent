import path from 'node:path';
import { homedir } from 'node:os';
import { realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { Task } from '@hikari/agent-core';
import type { Workspace, WorkspaceProject } from '@hikari/shared';
import type { LocalPersistence } from './persistence';
import { listWorkspaceProjects, openWorkspace } from './workspace';

const projectSchema = z.object({
  root: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  hidden: z.boolean().optional(),
  pinned: z.boolean().optional(),
  section: z.string().trim().min(1).max(60).optional(),
});
const projectName = z.string().trim().min(1).max(100);

/** A navigation registry. Removing a project never mutates tasks, checkpoints or files. */
export class WorkspaceProjects {
  constructor(
    private persistence: LocalPersistence,
    private tasks: () => Task[],
    private running: (id: string) => boolean = () => false,
  ) {}

  private overrides(): WorkspaceProject[] {
    const saved = z
      .array(projectSchema)
      .safeParse(this.persistence.get('model_configs', 'workspace-projects')?.data);
    return saved.success ? saved.data : [];
  }

  private save(project: WorkspaceProject): void {
    const projects = new Map(this.overrides().map((item) => [item.root, item]));
    projects.set(project.root, project);
    this.persistence.save('model_configs', 'workspace-projects', [...projects.values()]);
  }

  async list(): Promise<WorkspaceProject[]> {
    const saved: WorkspaceProject[] = this.overrides();
    for (let offset = 0; ; offset += 500) {
      const page = this.persistence.repository.listSync('workspaces', 'local', { offset });
      for (const record of page) {
        if (record.id.startsWith('demo:')) continue;
        const value = projectSchema.safeParse(record.data);
        if (value.success) saved.push(value.data);
      }
      if (page.length < 500) break;
    }
    return listWorkspaceProjects(
      saved,
      this.tasks()
        .filter(
          (task) => !task.chat && !task.demo && !!task.workspace && !task.workspace.includes('://'),
        )
        .map((task) => task.workspace),
    );
  }

  async find(root: string): Promise<WorkspaceProject> {
    const canonical = await realpath(root).catch(() => root);
    const project = (await this.list()).find(
      (item) => item.root === canonical || item.aliases?.includes(root),
    );
    if (!project) throw new Error('Project is not registered');
    return project;
  }

  async add(input: { path: string; name?: string }): Promise<Workspace> {
    let filename = z.string().trim().min(1).max(4096).parse(input.path);
    if (filename === '~' || filename.startsWith('~/') || filename.startsWith('~\\'))
      filename = path.join(homedir(), filename.slice(1));
    if (!path.isAbsolute(filename)) throw new Error('Enter an absolute file or folder path');
    const resolved = await realpath(filename);
    const info = await stat(resolved);
    if (!info.isDirectory() && !info.isFile()) throw new Error('Select a file or folder');
    const root = info.isFile() ? path.dirname(resolved) : resolved;
    const existing = (await this.list()).find((item) => item.root === root);
    const workspace = await openWorkspace(root);
    const project: WorkspaceProject = {
      root,
      name:
        input.name === undefined
          ? (existing?.name ?? workspace.name)
          : projectName.parse(input.name),
      aliases: [
        ...new Set([root, ...(existing?.aliases ?? []), ...(info.isDirectory() ? [filename] : [])]),
      ],
      hidden: false,
      pinned: existing?.pinned,
      section: existing?.section,
    };
    this.persistence.save('workspaces', root, project);
    this.save(project);
    return { ...workspace, name: project.name };
  }

  async rename(root: string, name: string): Promise<WorkspaceProject> {
    const project = { ...(await this.find(root)), name: projectName.parse(name) };
    this.save(project);
    return project;
  }

  async remove(root: string): Promise<WorkspaceProject> {
    const project = { ...(await this.find(root)), hidden: true };
    this.save(project);
    return project;
  }

  async organize(
    root: string,
    options: { pinned?: boolean; section?: string | null },
  ): Promise<WorkspaceProject> {
    const value = z
      .object({
        pinned: z.boolean().optional(),
        section: z.string().trim().min(1).max(60).nullable().optional(),
      })
      .parse(options);
    const project = { ...(await this.find(root)) };
    if (value.pinned !== undefined) project.pinned = value.pinned;
    if (value.section !== undefined) {
      project.section = value.section ?? undefined;
      project.pinned = false;
    }
    this.save(project);
    return project;
  }

  async archive(root: string): Promise<number> {
    const project = await this.find(root);
    const roots = new Set([project.root, ...(project.aliases ?? [])]);
    const tasks = this.tasks().filter(
      (task) => !task.chat && !task.demo && roots.has(task.workspace) && !task.archived,
    );
    if (
      tasks.some(
        (task) =>
          this.running(task.id) ||
          !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status),
      )
    )
      throw new Error('Finish or cancel active project tasks before archiving conversations');
    for (const task of tasks) {
      task.archived = true;
      this.persistence.task(task);
    }
    return tasks.length;
  }

  name(root: string): string | undefined {
    const project = this.overrides().find((item) => item.root === root);
    if (project) return project.name;
    const saved = projectSchema.safeParse(this.persistence.get('workspaces', root)?.data);
    return saved.success ? saved.data.name : undefined;
  }
}
