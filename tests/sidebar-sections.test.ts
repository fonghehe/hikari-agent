import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalPersistence } from '../apps/desktop/src/main/persistence';
import { SidebarSections } from '../apps/desktop/src/main/sidebar-sections';
import { TaskManager } from '../packages/agent-runtime/src';

describe('sidebar sections', () => {
  it('persists empty sections, rejects duplicates and reorganizes records without removing them', async () => {
    const data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-sections-')));
    const root = path.join(data, 'project');
    await mkdir(root);
    const persistence = new LocalPersistence(path.join(data, 'hakari.sqlite'));
    try {
      const tasks = new TaskManager();
      const project = tasks.create('Project task', root);
      project.status = 'completed';
      project.navigation = { unread: true };
      const chat = tasks.create('Chat', 'chat://test');
      chat.chat = true;
      chat.status = 'thinking';
      chat.navigation = { section: 'Research', unread: true };
      for (const task of tasks.list()) persistence.task(task);
      persistence.save('workspaces', root, { root, name: 'Project', section: 'Research' });
      const sections = new SidebarSections(persistence, () => tasks.list());
      await sections.create('Empty');
      expect(await new SidebarSections(persistence, () => tasks.list()).list()).toEqual([
        'Research',
        'Empty',
      ]);
      await expect(sections.create(' empty ')).rejects.toThrow('already exists');
      await expect(sections.archive('Research')).rejects.toThrow('active section tasks');
      expect(tasks.list().some((task) => task.archived)).toBe(false);
      await sections.markRead('Research');
      expect(tasks.list().every((task) => !task.navigation?.unread)).toBe(true);
      await sections.rename('Research', 'Work');
      expect(chat.navigation?.section).toBe('Work');
      expect((await persistence.repository.get('workspaces', 'local', root))?.data).toMatchObject({
        section: 'Research',
      });
      // The registry override, rather than the original workspace record, owns navigation.
      expect(await sections.list()).toEqual(['Work', 'Empty']);
      chat.status = 'completed';
      expect(await sections.archive('Work')).toBe(2);
      expect(tasks.list().every((task) => task.archived)).toBe(true);
      await sections.remove('Work');
      expect(await sections.list()).toEqual(['Empty']);
      expect(chat.navigation?.section).toBeUndefined();
      expect(tasks.list()).toHaveLength(2);
      expect(project.workspace).toBe(root);
      expect(chat.prompt).toBe('Chat');
    } finally {
      await persistence.close();
      await rm(data, { recursive: true, force: true });
    }
  });
});

it('assigns offline conversations before their first event and retains sections on follow-ups and retry', async () => {
  const { TaskHost } = await import('../apps/desktop/src/main/task-host');
  const { vi } = await import('vitest');
  const seen: (string | undefined)[] = [];
  const host = new TaskHost((event) => seen.push(host.tasks.get(event.taskId).navigation?.section));
  try {
    const first = await host.start(
      'Section question',
      '',
      false,
      undefined,
      { mode: 'plan', maxSteps: 5, requireTests: false },
      [],
      undefined,
      undefined,
      'Research',
    );
    await vi.waitFor(() => expect(first.status).toBe('completed'), { timeout: 5000 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((section) => section === 'Research')).toBe(true);
    const followUp = await host.start('Follow-up', '', false, first.id, {
      mode: 'plan',
      maxSteps: 5,
      requireTests: false,
    });
    await vi.waitFor(() => expect(followUp.status).toBe('completed'), { timeout: 5000 });
    expect(followUp.navigation?.section).toBe('Research');
    first.navigation = { section: 'Moved' };
    const retry = await host.control(first.id, 'retry');
    expect(retry?.navigation?.section).toBe('Moved');
  } finally {
    host.close();
  }
});
