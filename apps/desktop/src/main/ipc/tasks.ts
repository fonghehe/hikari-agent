import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { dialog, shell } from 'electron';
import { z } from 'zod';
import { redact, runOptionsSchema } from '@hikari/agent-core';
import { attachmentLimits } from '@hikari/shared';
import { demoWorkspace } from '@hikari/model-provider';
import { GitService, WorktreeService } from '@hikari/git';
import { WorktreeDelivery, FileChangeService } from '@hikari/tools';
import { SidebarSections } from '../sidebar-sections';
import { id, type DesktopContext, type RegisterHandler } from './context';
import {
  copyConversation,
  conversationMarkdown,
  conversationAnswer,
} from '../conversation-actions';

export function registerTasksHandlers(handle: RegisterHandler, context: DesktopContext) {
  const { host, persistence, workspaceState } = context;
  const root = () => workspaceState.require();
  handle('agent:start', async (prompt, isolated, parentTaskId, options, attachmentIds, section) => {
    const selectedSection = z.string().trim().min(1).max(60).optional().parse(section);
    if (
      selectedSection &&
      !(await new SidebarSections(persistence, () => host.tasks.list()).list()).includes(
        selectedSection,
      )
    )
      throw new Error('Section is not registered');
    return host.start(
      z.string().trim().min(1).max(24000).parse(prompt),
      !host.config ||
        host.config.provider === 'demo' ||
        (parentTaskId && host.tasks.get(id.parse(parentTaskId)).demo)
        ? demoWorkspace.root
        : parentTaskId
          ? host.tasks.get(id.parse(parentTaskId)).workspace
          : (workspaceState.root ?? ''),
      z.boolean().default(false).parse(isolated),
      id.optional().parse(parentTaskId),
      options === undefined ? undefined : runOptionsSchema.parse(options),
      z.array(id).max(attachmentLimits.maxFiles).default([]).parse(attachmentIds),
      undefined,
      undefined,
      selectedSection,
    );
  });
  handle('agent:list', () => host.tasks.list());
  const inactive = (taskId: unknown) => {
    const task = host.tasks.get(id.parse(taskId));
    if (
      host.runners.has(task.id) ||
      !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)
    )
      throw new Error('Finish or cancel this task before managing it');
    return task;
  };
  handle('agent:rename', (taskId, title) => {
    const task = host.tasks.get(id.parse(taskId));
    task.title = z.string().trim().min(1).max(120).parse(title);
    task.updatedAt = new Date().toISOString();
    persistence.task(task);
  });
  handle('agent:organize', (taskId, input) => {
    const task = host.tasks.get(id.parse(taskId));
    const options = z
      .object({
        pinned: z.boolean().optional(),
        unread: z.boolean().optional(),
        section: z.string().trim().min(1).max(60).nullable().optional(),
      })
      .strict()
      .parse(input);
    task.navigation = {
      ...task.navigation,
      ...options,
      section: options.section === null ? undefined : (options.section ?? task.navigation?.section),
    };
    persistence.task(task);
  });
  handle('agent:copy', (taskId, input) => {
    const task = host.tasks.get(id.parse(taskId));
    const format = z.enum(['title', 'prompt', 'answer', 'conversation', 'id']).parse(input);
    let text = String(
      redact(
        format === 'title'
          ? task.title
          : format === 'prompt'
            ? task.prompt
            : format === 'answer'
              ? conversationAnswer(task)
              : format === 'id'
                ? task.id
                : conversationMarkdown(task, (id) => host.tasks.get(id)),
      ),
    );
    for (const profile of host.profiles.values())
      for (const secret of [profile.apiKey, profile.embeddings?.apiKey])
        if (secret && secret.length >= 6) text = text.split(secret).join('[REDACTED]');
    if (text.length > 1000000)
      throw new Error('Conversation exceeds the clipboard limit; export it instead');
    return text;
  });
  handle('agent:fork', async (taskId, title, isolated) => {
    const source = inactive(taskId);
    const name = z.string().trim().min(1).max(120).parse(title);
    const separate = z.boolean().default(false).parse(isolated);
    if (source.worktreeArchive) throw new Error('Restore the archived worktree before forking');
    if (separate && source.worktree)
      throw new Error('Fork into another worktree from the original project conversation');
    if (separate && (source.demo || source.chat))
      throw new Error('Open a Git project to fork into a worktree');
    const task = copyConversation(source, host.tasks.create(source.prompt, source.workspace), name);
    // Follow-ups must not see the fork until its worktree has finished setup.
    host.tasks.remove(task.id);
    try {
      if (separate)
        task.worktree = await new WorktreeService(source.workspace).create(task.id, 'working-tree');
      if (source.demo) {
        const demo = host.demos.get(source.id);
        const files = { ...demo?.files };
        host.demos.set(task.id, { files, changes: [] });
        persistence.save('workspaces', `demo:${task.id}`, files);
      }
      persistence.task(task);
      host.tasks.restore(task);
      return task;
    } catch (error) {
      host.tasks.remove(task.id);
      throw error;
    }
  });
  handle('agent:openWindow', async (taskId) => {
    const task = host.tasks.get(id.parse(taskId));
    if (!context.openTaskWindow) throw new Error('Task windows are unavailable');
    await context.openTaskWindow(task.id);
  });
  handle('agent:openExternal', async (taskId, target) => {
    const task = host.tasks.get(id.parse(taskId));
    const application = z.enum(['system', 'vscode']).parse(target);
    if (task.chat || task.demo || task.worktreeArchive)
      throw new Error('This conversation has no local folder');
    const folder = task.worktree ?? task.workspace;
    if (!path.isAbsolute(folder) || !(await stat(folder)).isDirectory())
      throw new Error('Project folder is unavailable');
    if (application === 'system') {
      const error = await shell.openPath(folder);
      if (error) throw new Error(error);
    } else {
      const url = new URL('vscode://file');
      url.pathname = folder;
      await shell.openExternal(url.toString());
    }
  });
  handle('agent:archive', (taskId, archived) => {
    const task = inactive(taskId);
    task.archived = z.boolean().parse(archived);
    persistence.task(task);
  });
  handle('agent:remove', (taskId) => removeSavedTask(context, id.parse(taskId)));
  handle('agent:export', async (taskId) => {
    const task = host.tasks.get(id.parse(taskId));
    const result = await dialog.showSaveDialog(context.window, {
      defaultPath: 'hikari-conversation.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return false;
    const final = task.events
      .slice()
      .reverse()
      .find((event) => event.type === 'agent.completed');
    const content = {
      format: 'hikari-conversation',
      version: 1,
      title: task.title,
      prompt: task.prompt,
      answer: typeof final?.data.text === 'string' ? final.data.text : '',
      status: task.status,
      plan: task.plan,
      summary: task.runSummary,
      attachments: task.attachments?.map((item) => ({
        name: item.name,
        kind: item.kind,
        mimeType: item.mimeType,
      })),
    };
    let encoded = JSON.stringify(redact(content), null, 2);
    for (const profile of host.profiles.values())
      for (const secret of [profile.apiKey, profile.embeddings?.apiKey])
        if (secret && secret.length >= 6) encoded = encoded.split(secret).join('[REDACTED]');
    await writeFile(result.filePath, encoded, { mode: 0o600 });
    return true;
  });
  handle('agent:import', async () => {
    const selected = await dialog.showOpenDialog(context.window, {
      properties: ['openFile'],
      filters: [{ name: 'Hikari conversation', extensions: ['json'] }],
    });
    const filename = selected.filePaths[0];
    if (selected.canceled || !filename) return undefined;
    if ((await stat(filename)).size > 2000000) throw new Error('Conversation exceeds 2 MB');
    const value = z
      .object({
        format: z.literal('hikari-conversation'),
        version: z.literal(1),
        title: z.string().max(120),
        prompt: z.string().max(24000),
        answer: z.string().max(1000000),
      })
      .parse(JSON.parse(await readFile(filename, 'utf8')));
    const task = host.tasks.create(value.prompt, workspaceState.root ?? `chat://hikari/imported`);
    task.title = value.title;
    task.imported = true;
    task.chat = !workspaceState.root || undefined;
    const bus = new (await import('@hikari/agent-runtime')).EventBus(task);
    bus.emit('agent.state', { state: 'planning' });
    bus.emit('agent.state', { state: 'thinking' });
    bus.emit('agent.completed', { text: value.answer });
    bus.emit('agent.state', { state: 'completed' });
    persistence.task(task);
    return task;
  });
  handle('agent:editMemory', (scope, entry) =>
    host.editMemory(
      z.string().min(1).max(4000).parse(scope),
      z
        .object({
          id,
          title: z.string().min(1).max(150),
          content: z.string().min(1).max(4000),
          source: z.string().max(500).optional(),
          expiresAt: z.string().datetime().optional(),
        })
        .parse(entry),
    ),
  );
  handle('agent:grants', () =>
    persistence.repository.listSync('grants', 'local').map((record) => ({
      id: record.id,
      description: String(
        redact(
          (record.data as { description?: string }).description ?? 'Legacy persistent permission',
        ),
      ),
      updatedAt: record.updatedAt,
    })),
  );
  handle('agent:revokeGrant', async (value) => {
    await persistence.repository.remove(
      'grants',
      'local',
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(value),
    );
    host.revokeSessionGrants();
  });
  const deliveries = new Map<string, WorktreeDelivery>();
  const worktreeTask = (value: unknown) => {
    const task = inactive(value);
    if (!task.worktree || task.demo || task.chat)
      throw new Error('This task has no isolated worktree');
    if (
      host.tasks.list().some((item) => item.worktree === task.worktree && host.runners.has(item.id))
    )
      throw new Error('Finish all tasks using this worktree before delivery or cleanup');
    return task;
  };
  handle('worktree:preview', async (taskId) => {
    const task = worktreeTask(taskId);
    const delivery = new WorktreeDelivery(task.workspace);
    deliveries.set(task.id, delivery);
    const worktreeId = path.basename(task.worktree!);
    return delivery.preview(worktreeId);
  });
  handle('worktree:apply', async (taskId, previewId) => {
    const task = worktreeTask(taskId),
      delivery = deliveries.get(task.id);
    if (!delivery) throw new Error('Preview delivery first');
    if (
      host.tasks
        .list()
        .some(
          (item) =>
            (item.worktree ?? item.workspace) === task.workspace && host.runners.has(item.id),
        )
    )
      throw new Error('Finish tasks in the original workspace before applying delivery');
    const changes = new FileChangeService(task.workspace, { emit() {} });
    await delivery.apply(id.parse(previewId), changes);
    persistence.save('changes', `delivery:${task.id}`, changes.history);
    deliveries.delete(task.id);
  });
  handle('worktree:restore', async (value) => {
    const task = inactive(value);
    if (!task.worktreeArchive) throw new Error('This task has no archived worktree');
    const target = await new WorktreeService(task.workspace).restore(task.worktreeArchive);
    const archive = task.worktreeArchive;
    for (const item of host.tasks.list())
      if (item.worktreeArchive === archive) {
        item.worktree = target;
        item.worktreeArchive = undefined;
        persistence.task(item);
      }
  });
  handle('worktree:undoDelivery', async (value) => {
    const task = inactive(value);
    if (
      host.tasks
        .list()
        .some(
          (item) =>
            !item.worktree && item.workspace === task.workspace && host.runners.has(item.id),
        )
    )
      throw new Error('Finish workspace tasks before undoing delivered changes');
    const history = persistence.get('changes', `delivery:${task.id}`)?.data as
      | import('@hikari/tools').Change[]
      | undefined;
    if (!history?.length) throw new Error('No delivered changes to undo');
    const service = new FileChangeService(task.workspace, { emit() {} });
    service.history.push(...history);
    for (const change of service.history.slice().reverse())
      if (!change.undone) {
        await service.undo(change.id);
        persistence.save('changes', `delivery:${task.id}`, service.history);
      }
  });
  handle('worktree:archive', async (taskId) => {
    const task = worktreeTask(taskId),
      target = task.worktree!;
    if (host.tasks.list().some((item) => item.worktree === target && item.status === 'interrupted'))
      throw new Error('Cancel or finish interrupted worktree tasks before archiving');
    const archive = await new WorktreeService(task.workspace).archive(path.basename(target));
    for (const item of host.tasks.list())
      if (item.worktree === target) {
        item.worktree = undefined;
        item.worktreeArchive = archive;
        item.resumable = false;
        persistence.task(item);
        const checkpoint = persistence.checkpoints.load(item.id);
        if (checkpoint) persistence.checkpoints.save(item.id, { ...checkpoint, done: true });
      }
    return archive;
  });

  handle('agent:control', (taskId, action) =>
    host.control(id.parse(taskId), z.enum(['pause', 'resume', 'cancel', 'retry']).parse(action)),
  );
  handle('agent:answer', (taskId, questionId, answer) =>
    host.answer(
      id.parse(taskId),
      id.parse(questionId),
      z.string().trim().min(1).max(12000).parse(answer),
    ),
  );
  handle('agent:input', (taskId, text) =>
    host.input(id.parse(taskId), z.string().trim().min(1).max(12000).parse(text)),
  );
  handle('agent:memories', (scope) => host.memory(z.string().min(1).max(4000).parse(scope)));
  handle('agent:forget', (scope, entry) =>
    host.forget(z.string().min(1).max(4000).parse(scope), id.parse(entry)),
  );
  handle('agent:approve', (taskId, requestId, decision) =>
    host.approve(
      id.parse(taskId),
      z.string().parse(requestId),
      z.enum(['once', 'session', 'always', 'deny']).parse(decision),
    ),
  );
  handle('git:diff', (taskId) => {
    if (taskId && host.tasks.get(id.parse(taskId)).chat) return '';
    if (taskId && host.tasks.get(id.parse(taskId)).demo)
      return (
        host.demos
          .get(id.parse(taskId))
          ?.changes.map(
            (change) => `[Simulated] ${change.path}\n${change.before}\n→\n${change.after}`,
          )
          .join('\n') ?? ''
      );
    return new GitService(
      taskId
        ? (host.tasks.get(id.parse(taskId)).worktree ?? host.tasks.get(id.parse(taskId)).workspace)
        : root(),
    ).diff();
  });
  handle(
    'git:changes',
    (taskId) =>
      host.demos.get(id.parse(taskId))?.changes ??
      host.changes.get(id.parse(taskId))?.history ??
      [],
  );
  handle('git:review', async (taskId, changeId, action) => {
    const task = host.tasks.get(id.parse(taskId));
    if (!['completed', 'failed', 'cancelled', 'paused'].includes(task.status))
      throw new Error('Pause or finish the task before reviewing changes');
    const operation = z.enum(['accept', 'reject', 'undo']).parse(action);
    if (task.demo) {
      host.reviewDemo(task, id.parse(changeId), operation);
      host.notifyReview(task, id.parse(changeId), operation);
      return;
    }
    const changes = host.changes.get(task.id);
    if (!changes) throw new Error('No changes');
    if (operation === 'accept') changes.accept(id.parse(changeId));
    else await changes.undo(id.parse(changeId));
    persistence.task(task, undefined, changes.history);
    host.notifyReview(task, id.parse(changeId), operation);
  });
}

export async function removeSavedTask(context: DesktopContext, taskId: string): Promise<void> {
  const { host, persistence } = context;
  const task = host.tasks.get(taskId);
  if (
    host.runners.has(task.id) ||
    !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)
  )
    throw new Error('Finish or cancel this task before managing it');
  if (task.worktree) throw new Error('Archive the isolated worktree before deleting its task');
  for (const child of host.tasks.list())
    if (child.parentTaskId === task.id) {
      child.parentTaskId = task.parentTaskId;
      persistence.task(child);
    }
  persistence.removeTaskOutputs(task.id);
  await persistence.repository.remove('tasks', 'local', task.id);
  await persistence.repository.remove('changes', 'local', task.id);
  await persistence.repository.remove('messages', 'local', `checkpoint:${task.id}`);
  for (const event of task.events) await persistence.repository.remove('events', 'local', event.id);
  await persistence.repository.remove('workspaces', 'local', `demo:${task.id}`);
  host.tasks.remove(task.id);
  host.changes.delete(task.id);
  host.demos.delete(task.id);
  await persistence.removeOrphanAttachments();
}
