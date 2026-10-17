import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalPersistence } from '../../apps/desktop/src/main/persistence';
import { TaskManager } from '../../packages/agent-runtime/src';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

test('conversation menus persist organization, copy and fork content, open independent windows and confirm deletion', async () => {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-conversation-menu-')));
  const root = path.join(data, 'project');
  await mkdir(root);
  const store = new LocalPersistence(path.join(data, 'hakari.sqlite'));
  const manager = new TaskManager();
  const chat = manager.create('General question', 'chat://hikari/menu');
  chat.chat = true;
  chat.status = 'completed';
  chat.events = [
    {
      id: '4a144cd0-7d97-4906-9952-73efbb234bbe',
      taskId: chat.id,
      agentId: chat.agentId,
      timestamp: chat.updatedAt,
      type: 'agent.completed',
      data: { text: 'Saved answer' },
    },
  ];
  const projectTask = manager.create('Project conversation', root);
  projectTask.status = 'completed';
  for (const task of [chat, projectTask]) store.task(task);
  await store.close();
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    const page = await app.firstWindow();
    const nav = page.getByRole('navigation', { name: 'Conversations and projects' });
    const row = () => nav.locator('.task-button').filter({ hasText: 'General question' });
    const menu = page.getByRole('menu', { name: 'Conversation actions', exact: true });
    const show = async () => {
      await row().click({ button: 'right' });
      await expect(menu).toBeVisible();
    };
    await show();
    for (const name of [
      'Rename',
      'Pin',
      'Mark as unread',
      'Section',
      'Fork',
      'Share',
      'Copy',
      'Open in new window',
      'Open with',
      'Archive',
      'Permanently delete',
    ])
      await expect(menu.getByRole('menuitem', { name, exact: true })).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds!.width).toBeLessThan(230);
    expect(bounds!.height).toBeLessThan(420);
    await menu.getByRole('menuitem', { name: 'Mark as unread', exact: true }).click();
    await expect(row()).toHaveAttribute('data-unread', 'true');
    await page.reload();
    await expect(row()).toHaveAttribute('data-unread', 'true');
    await row().click();
    await expect(row()).toHaveAttribute('data-unread', 'false');
    await show();
    await menu.getByRole('menuitem', { name: 'Pin', exact: true }).click();
    await expect(nav.getByRole('region', { name: 'Pinned', exact: true })).toContainText(
      'General question',
    );
    await show();
    await menu.getByRole('menuitem', { name: 'Section', exact: true }).hover();
    await expect(menu.getByRole('menuitem', { name: 'New section…', exact: true })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'New section…', exact: true }).click();
    const section = page.getByRole('dialog', { name: 'New section…', exact: true });
    await section.getByRole('textbox', { name: 'Section name', exact: true }).fill('Research');
    await section.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(nav.getByRole('region', { name: 'Research', exact: true })).toContainText(
      'General question',
    );
    await page.reload();
    await expect(nav.getByRole('region', { name: 'Research', exact: true })).toContainText(
      'General question',
    );
    await show();
    await menu.getByRole('menuitem', { name: 'Copy', exact: true }).hover();
    await menu.getByRole('menuitem', { name: 'Copy conversation', exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Saved answer');
    await show();
    await menu.getByRole('menuitem', { name: 'Share', exact: true }).click();
    const share = page.getByRole('dialog', { name: 'Share conversation', exact: true });
    await expect(
      share.getByRole('textbox', { name: 'Conversation text', exact: true }),
    ).toHaveValue(/Saved answer/);
    await share.getByRole('button', { name: 'Close', exact: true }).click();
    await show();
    await menu.getByRole('menuitem', { name: 'Fork', exact: true }).hover();
    await menu.getByRole('menuitem', { name: 'Fork conversation', exact: true }).click();
    await expect(
      nav.locator('.task-button').filter({ hasText: 'General question (fork)' }),
    ).toHaveCount(1);
    const forks = await page.evaluate(async () =>
      (await window.hikari!.agent.list()).filter((task) => task.title.includes('(fork)')),
    );
    expect(forks).toHaveLength(1);
    expect(forks[0]!.events[0]!.data.text).toBe('Saved answer');
    await nav
      .locator('.task-button')
      .filter({ hasText: 'General question (fork)' })
      .click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Permanently delete', exact: true }).click();
    const deletion = page.getByRole('dialog', { name: 'Permanently delete?', exact: true });
    await expect(deletion.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await page.evaluate(async () => (await window.hikari!.agent.list()).length)).toBe(3);
    await nav
      .locator('.task-button')
      .filter({ hasText: 'General question (fork)' })
      .click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Permanently delete', exact: true }).click();
    await deletion.getByRole('button', { name: 'Permanently delete', exact: true }).click();
    await expect(nav.locator('.task-button').filter({ hasText: '(fork)' })).toHaveCount(0);
    await show();
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const rename = page.getByRole('dialog', { name: 'Rename conversation', exact: true });
    await rename.getByRole('textbox', { name: 'Task name', exact: true }).fill('Renamed chat');
    await rename.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(nav.locator('.task-button').filter({ hasText: 'Renamed chat' })).toHaveCount(1);

    // A second window has its own workspace and a functioning, trusted IPC connection.
    await nav
      .locator('.task-button')
      .filter({ hasText: 'Project conversation' })
      .click({ button: 'right' });
    const opened = app.waitForEvent('window');
    await menu.getByRole('menuitem', { name: 'Open in new window', exact: true }).click();
    const other = await opened;
    await other.waitForLoadState();
    await expect(other.locator('.task-view')).toContainText('Project conversation');
    expect((await other.evaluate(() => window.hikari!.workspace.snapshot()))?.root).toBe(root);
    expect(await page.evaluate(() => window.hikari!.workspace.snapshot())).toBeNull();
    await other.close();
    await nav
      .locator('.task-button')
      .filter({ hasText: 'Renamed chat' })
      .click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Archive', exact: true }).click();
    await expect(nav.locator('.task-button').filter({ hasText: 'Renamed chat' })).toHaveCount(0);
    expect(
      (
        await page.evaluate(
          async (id) => (await window.hikari!.agent.list()).find((task) => task.id === id),
          chat.id,
        )
      )?.archived,
    ).toBe(true);
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});

test('settings tabs keep a stable window, scroll internally and use the selected language', async () => {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-settings-layout-')));
  const root = path.join(data, 'project');
  await mkdir(root);
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async (root) => {
      await window.hikari!.workspace.add({ path: root });
      await window.hikari!.preferences.set({ theme: 'light', language: 'zh-CN' });
    }, root);
    await page.reload();
    await page.getByRole('button', { name: '在 project 中新建任务', exact: true }).click();
    await page.getByRole('button', { name: '记忆与扩展', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '记忆与扩展', exact: true });
    const bounds = await settings.boundingBox();
    for (const name of ['记忆', '扩展', '自动化与集成']) {
      await settings.getByRole('tab', { name, exact: true }).click();
      expect(await settings.boundingBox()).toEqual(bounds);
      await expect(settings.getByRole('tabpanel')).toHaveCount(1);
    }
    await settings.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '数据与更新', exact: true }).click();
    const globalSettings = page.getByRole('dialog', { name: '数据与更新', exact: true });
    const buttons = await globalSettings
      .locator('.settings-actions .button')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const bounds = element.getBoundingClientRect();
          return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom };
        }),
      );
    for (let index = 1; index < buttons.length; index++) {
      const before = buttons[index - 1]!,
        after = buttons[index]!;
      expect(
        after.y > before.y ? after.y - before.bottom : after.x - before.right,
      ).toBeGreaterThanOrEqual(8);
    }
    await page.screenshot({ path: 'test-results/settings-data-spacing.png' });
    await globalSettings.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '记忆与扩展', exact: true }).click();
    await settings.getByRole('tab', { name: '扩展', exact: true }).click();
    await settings.getByLabel('连接方式', { exact: true }).selectOption('stdio');
    await expect(settings.getByRole('combobox')).toContainText('本地进程');
    await settings.getByRole('tab', { name: '自动化与集成', exact: true }).click();
    await settings.getByText('定时任务', { exact: true }).click();
    await settings.getByText('生命周期钩子', { exact: true }).click();
    const panel = settings.getByRole('tabpanel');
    expect(await panel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    expect(await settings.boundingBox()).toEqual(bounds);
    await panel.evaluate((element) => (element.scrollTop = element.scrollHeight));
    expect(
      await settings
        .getByRole('tablist')
        .evaluate((element) => element.getBoundingClientRect().top),
    ).toBeGreaterThan(bounds!.y);
    await page.screenshot({ path: 'test-results/settings-stable-tabs.png' });
    await settings.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => window.hikari!.preferences.set({ theme: 'light', language: 'ja' }));
    await page.reload();
    await page.getByRole('button', { name: 'メモリーと拡張機能', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'メモリーと拡張機能', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});

test('section controls edit, mark read, archive, create empty sections and remove organization without deleting records', async () => {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-section-menu-')));
  const root = path.join(data, 'project');
  await mkdir(root);
  const store = new LocalPersistence(path.join(data, 'hakari.sqlite'));
  const manager = new TaskManager();
  const project = manager.create('Project history', root);
  const chat = manager.create('Research chat', 'chat://research');
  chat.chat = true;
  for (const task of [project, chat]) {
    task.status = 'completed';
    task.navigation = { unread: true, ...(task.chat ? { section: 'Research' } : {}) };
    store.task(task);
  }
  store.save('workspaces', root, { root, name: 'project', section: 'Research' });
  await store.close();
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    const page = await app.firstWindow();
    const nav = page.getByRole('navigation', { name: 'Conversations and projects' });
    const section = (name: string) => nav.getByRole('region', { name, exact: true });
    const menu = page.getByRole('menu', { name: 'Section actions', exact: true });
    const open = async (name: string) =>
      section(name)
        .getByRole('button', { name: `Manage section ${name}`, exact: true })
        .click();
    await expect(section('Research').locator('.task-button')).toHaveCount(2);
    await open('Research');
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Edit',
      'Mark all as read',
      'Archive chats',
      'New section…',
      'Remove section',
    ]);
    await menu.getByRole('menuitem', { name: 'Mark all as read', exact: true }).click();
    await expect(section('Research').locator('.task-button[data-unread="true"]')).toHaveCount(0);
    await open('Research');
    await expect(
      menu.getByRole('menuitem', { name: 'Mark all as read', exact: true }),
    ).toBeDisabled();
    await menu.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit section', exact: true });
    await edit.getByRole('textbox', { name: 'Section name', exact: true }).fill('Work');
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(section('Research')).toHaveCount(0);
    await expect(section('Work').locator('.task-button')).toHaveCount(2);
    await open('Work');
    await menu.getByRole('menuitem', { name: 'New section…', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'New section…', exact: true });
    await create.getByRole('textbox', { name: 'Section name', exact: true }).fill('Empty');
    await create.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(section('Empty')).toBeVisible();
    await open('Work');
    await menu.getByRole('menuitem', { name: 'New section…', exact: true }).click();
    await create.getByRole('textbox', { name: 'Section name', exact: true }).fill('Empty');
    await create.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(create.getByRole('alert')).toHaveText('A section with this name already exists');
    await create.getByRole('button', { name: 'Close', exact: true }).click();
    await page.reload();
    await expect(section('Empty')).toBeVisible();
    await open('Work');
    await menu.getByRole('menuitem', { name: 'Remove section', exact: true }).click();
    const remove = page.getByRole('dialog', { name: 'Remove section?', exact: true });
    await expect(remove.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await remove.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(section('Work').locator('.task-button')).toHaveCount(2);
    await open('Work');
    await menu.getByRole('menuitem', { name: 'Remove section', exact: true }).click();
    await remove.getByRole('button', { name: 'Remove section', exact: true }).click();
    await expect(section('Work')).toHaveCount(0);
    await expect(section(root).locator('.task-button')).toContainText('Project history');
    await expect(section('Recent').locator('.task-button')).toContainText('Research chat');
    expect(await page.evaluate(async () => (await window.hikari!.agent.list()).length)).toBe(2);
    // Moving a project to an existing section also makes its nested chats section members.
    await page.evaluate(
      async ({ root, chat }) => {
        await window.hikari!.workspace.organize(root, { section: 'Empty' });
        await window.hikari!.agent.organize(chat, { section: 'Empty' });
      },
      { root, chat: chat.id },
    );
    await page.reload();
    await expect(section('Empty').locator('.task-button')).toHaveCount(2);
    await open('Empty');
    await menu.getByRole('menuitem', { name: 'Archive chats', exact: true }).click();
    await expect(section('Empty').locator('.task-button')).toHaveCount(0);
    expect(
      (await page.evaluate(() => window.hikari!.agent.list())).every((task) => task.archived),
    ).toBe(true);
    await open('Empty');
    await expect(menu.getByRole('menuitem', { name: 'Archive chats', exact: true })).toBeDisabled();
    await page.screenshot({ path: 'test-results/section-menu.png' });
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});

test('project openers use the selected task folder and a worktree fork preserves working files', async () => {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-project-openers-')));
  const root = path.join(data, 'project');
  await mkdir(root);
  execFileSync('git', ['init', '--quiet', root]);
  await writeFile(path.join(root, 'file.txt'), 'Original');
  execFileSync('git', ['-C', root, 'add', 'file.txt']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  await writeFile(path.join(root, 'file.txt'), 'Uncommitted source');
  const store = new LocalPersistence(path.join(data, 'hakari.sqlite'));
  const task = new TaskManager().create('Project fork', root);
  task.status = 'completed';
  store.task(task);
  await store.close();
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      shell.openPath = async (folder) => {
        opened.push(folder);
        return '';
      };
      shell.openExternal = async (url) => {
        opened.push(url);
      };
      Reflect.set(globalThis, 'fixtureOpenedPaths', opened);
    });
    const page = await app.firstWindow();
    const row = page.locator('.task-button').filter({ hasText: 'Project fork' });
    const menu = page.getByRole('menu', { name: 'Conversation actions', exact: true });
    for (const opener of ['System file manager', 'VS Code']) {
      await row.click({ button: 'right' });
      await menu.getByRole('menuitem', { name: 'Open with', exact: true }).hover();
      await menu.getByRole('menuitem', { name: opener, exact: true }).click();
    }
    const paths = await app.evaluate(() => Reflect.get(globalThis, 'fixtureOpenedPaths'));
    expect(paths).toEqual([root, `vscode://file${root}`]);
    await row.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Fork', exact: true }).hover();
    await menu.getByRole('menuitem', { name: 'Fork into a new worktree', exact: true }).click();
    await expect(page.locator('.task-button').filter({ hasText: '(fork)' })).toHaveCount(1);
    const fork = (await page.evaluate(() => window.hikari!.agent.list())).find(
      (item) => item.id !== task.id,
    )!;
    expect(fork.workspace).toBe(root);
    expect(fork.worktree).toBeTruthy();
    expect(await readFile(path.join(fork.worktree!, 'file.txt'), 'utf8')).toBe(
      'Uncommitted source',
    );
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('Uncommitted source');
    await page.reload();
    expect(
      (await page.evaluate(() => window.hikari!.agent.list())).find((item) => item.id === fork.id)
        ?.worktree,
    ).toBe(fork.worktree);
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});
