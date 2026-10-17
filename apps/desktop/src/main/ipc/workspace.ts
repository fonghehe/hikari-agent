import { dialog } from 'electron';
import { z } from 'zod';
import { attachmentLimits } from '@hikari/shared';
import { RepositoryIndexer } from '@hikari/tools';
import { demoWorkspace } from '@hikari/model-provider';
import { openWorkspace, readWorkspaceFile } from '../workspace';
import { WorkspaceProjects } from '../projects';
import { SidebarSections } from '../sidebar-sections';
import { id, type DesktopContext, type RegisterHandler } from './context';

export function registerWorkspaceHandlers(handle: RegisterHandler, context: DesktopContext) {
  const { host, persistence, workspaceState } = context;
  const root = () => workspaceState.require();
  const projects = new WorkspaceProjects(
    persistence,
    () => host.tasks.list(),
    (id) => host.runners.has(id),
  );
  const sections = new SidebarSections(
    persistence,
    () => host.tasks.list(),
    (id) => host.runners.has(id),
  );
  handle('sections:list', () => sections.list());
  handle('sections:create', (name) => sections.create(z.string().parse(name)));
  handle('sections:rename', (name, next) =>
    sections.rename(z.string().parse(name), z.string().parse(next)),
  );
  handle('sections:remove', (name) => sections.remove(z.string().parse(name)));
  handle('sections:markRead', (name) => sections.markRead(z.string().parse(name)));
  handle('sections:archive', (name) => sections.archive(z.string().parse(name)));
  const openProject = async (input: { path: string; name?: string }) => {
    const workspace = await projects.add(input);
    workspaceState.root = workspace.root;
    try {
      workspace.files = await new RepositoryIndexer(workspace.root).findFiles();
    } catch {
      /* Directory listing is a fallback when rg is absent. */
    }
    return workspace;
  };
  handle('workspace:clear', () => {
    workspaceState.root = undefined;
  });
  handle('attachments:pick', async () => {
    const result = await dialog.showOpenDialog(context.window, {
      properties: ['openFile', 'multiSelections'],
    });
    return result.canceled ? { items: [], errors: [] } : host.attachments.pick(result.filePaths);
  });
  handle('attachments:import', (files) =>
    host.attachments.import(
      z
        .array(
          z.object({
            name: z.string().max(200),
            bytes: z
              .instanceof(Uint8Array)
              .refine(
                (bytes) => bytes.byteLength <= attachmentLimits.maxFileBytes,
                'Each file must be at most 10 MB',
              ),
          }),
        )
        .max(attachmentLimits.maxFiles)
        .parse(files),
    ),
  );
  handle('attachments:read', (attachmentId) => host.attachments.read(id.parse(attachmentId)));
  handle('workspace:recent', () => projects.list());
  handle('workspace:add', (input) =>
    openProject(
      z
        .object({
          path: z.string().trim().min(1).max(4096),
          name: z.string().trim().min(1).max(100).optional(),
        })
        .parse(input),
    ),
  );
  handle('workspace:rename', (value, name) =>
    projects.rename(z.string().parse(value), z.string().parse(name)),
  );
  handle('workspace:organize', (value, options) =>
    projects.organize(
      z.string().parse(value),
      z
        .object({
          pinned: z.boolean().optional(),
          section: z.string().trim().min(1).max(60).nullable().optional(),
        })
        .parse(options),
    ),
  );
  handle('workspace:archive', (value) => projects.archive(z.string().parse(value)));
  handle('workspace:remove', async (value) => {
    const removed = await projects.remove(z.string().parse(value));
    if (
      workspaceState.root === removed.root ||
      removed.aliases?.includes(workspaceState.root ?? '')
    )
      workspaceState.root = undefined;
  });
  handle('workspace:select', async (value) => {
    const project = await projects.find(z.string().min(1).max(4096).parse(value));
    if (project.hidden) throw new Error('Add this project again before selecting it');
    return openProject({ path: project.root });
  });
  const pickProjectPath = async (kind: unknown) => {
    const type = z.enum(['directory', 'file']).default('directory').parse(kind);
    const result = await dialog.showOpenDialog(context.window, {
      properties: [type === 'file' ? 'openFile' : 'openDirectory'],
    });
    const selected = result.filePaths[0];
    return result.canceled || !selected ? null : selected;
  };
  handle('workspace:pick', pickProjectPath);
  handle('workspace:open', async (kind) => {
    const selected = await pickProjectPath(kind);
    return selected ? openProject({ path: selected }) : null;
  });
  handle('workspace:read', (file, taskId) => {
    const task = taskId ? host.tasks.get(id.parse(taskId)) : undefined;
    const filename = z.string().max(4096).parse(file);
    if (task?.chat)
      throw new Error(
        'This conversation has no project files. Open a workspace and start a new task.',
      );
    if (task?.demo) {
      const files = host.demos.get(task.id)?.files;
      const content = files && Object.hasOwn(files, filename) ? files[filename] : undefined;
      if (content === undefined) throw new Error('Demo file not found');
      return content;
    }
    return readWorkspaceFile(task ? (task.worktree ?? task.workspace) : root(), filename);
  });
  handle('workspace:snapshot', async (taskId) => {
    const task = taskId ? host.tasks.get(id.parse(taskId)) : undefined;
    if (task?.chat) return null;
    if (task?.demo)
      return {
        ...demoWorkspace,
        root: task.workspace,
        files: Object.keys(host.demos.get(task.id)?.files ?? {}),
      };
    const selected = task ? (task.worktree ?? task.workspace) : workspaceState.root;
    if (!selected) return null;
    const workspace = await openWorkspace(selected);
    workspace.name = projects.name(workspace.root) ?? workspace.name;
    try {
      workspace.files = await new RepositoryIndexer(workspace.root).findFiles();
    } catch {
      /* Keep directory fallback. */
    }
    return workspace;
  });
}
