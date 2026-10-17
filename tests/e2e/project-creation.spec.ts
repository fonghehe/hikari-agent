import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalPersistence } from '../../apps/desktop/src/main/persistence';
import { TaskManager } from '../../packages/agent-runtime/src';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

test('project dialog localizes every source action and keeps the full focus ring visible', async () => {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-project-locale-')));
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    const page = await app.firstWindow();
    for (const locale of [
      {
        language: 'zh-CN',
        add: '新增项目',
        title: '创建项目',
        name: '项目名称',
        source: '源文件夹选项',
        actions: ['选择文件夹', '选择文件', '输入路径', '添加文件夹', '取消', '创建项目'],
      },
      {
        language: 'ja',
        add: 'プロジェクトを追加',
        title: 'プロジェクトを作成',
        name: 'プロジェクト名',
        source: 'ソースのオプション',
        actions: [
          'フォルダーを選択',
          'ファイルを選択',
          'パスを入力',
          'フォルダーを追加',
          'キャンセル',
          'プロジェクトを作成',
        ],
      },
      {
        language: 'en',
        add: 'Add project',
        title: 'Create project',
        name: 'Project name',
        source: 'Source options',
        actions: [
          'Choose folder',
          'Choose file',
          'Enter a path',
          'Add folder',
          'Cancel',
          'Create project',
        ],
      },
    ] as const) {
      await page.evaluate(
        (language) => window.hikari!.preferences.set({ language, theme: 'light' }),
        locale.language,
      );
      await page.reload();
      await page.setViewportSize({ width: 740, height: 560 });
      await page.getByRole('button', { name: locale.add, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: locale.title, exact: true });
      await expect(dialog.getByRole('textbox', { name: locale.name, exact: true })).toBeFocused();
      const clipped = await dialog.locator('.project-name-field').evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const outward = Math.max(
          0,
          parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset),
        );
        const result: string[] = [];
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const css = getComputedStyle(parent);
          const box = parent.getBoundingClientRect();
          if (
            css.overflowY !== 'visible' &&
            (bounds.top - outward < box.top || bounds.bottom + outward > box.bottom)
          )
            result.push(parent.className);
          if (parent === element.closest('dialog')) break;
        }
        return result;
      });
      expect(
        clipped,
        `${locale.language}: the focus indicator must not be cropped by a scroll container`,
      ).toEqual([]);
      await page.screenshot({
        path: `test-results/project-dialog-focus-${locale.language}.png`,
        scale: 'css',
      });
      await dialog.getByLabel(locale.source, { exact: true }).click();
      const sourceMenu = await dialog.locator('.project-source-menu').boundingBox();
      const actions = await dialog.locator('.project-dialog-actions').boundingBox();
      expect(sourceMenu!.y + sourceMenu!.height).toBeLessThan(actions!.y);
      const labels = await dialog.locator('button:not(.dialog-close)').allTextContents();
      expect(labels.map((label) => label.trim())).toEqual([...locale.actions]);
      await page.screenshot({
        path: `test-results/project-dialog-source-${locale.language}.png`,
        scale: 'css',
      });
      await page.keyboard.press('Escape');
    }
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});

test('folder selection is staged until creation and cancellation leaves the workspace intact', async () => {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-project-create-')));
  const root = path.join(data, 'website');
  await mkdir(root);
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [root],
      })) as typeof dialog.showOpenDialog;
    }, root);
    const page = await app.firstWindow();
    await page.evaluate(() =>
      window.hikari!.preferences.set({ theme: 'light', language: 'zh-CN' }),
    );
    await page.reload();
    const nav = page.getByRole('navigation', { name: '对话与项目' });
    await nav.getByRole('button', { name: '新增项目', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '创建项目', exact: true });
    await expect(dialog.getByRole('textbox', { name: '项目名称' })).toBeFocused();
    await expect(dialog.getByRole('button', { name: '创建项目', exact: true })).toBeDisabled();
    await dialog.getByRole('textbox', { name: '项目名称' }).fill('My website');
    await dialog.getByRole('button', { name: '添加文件夹', exact: true }).click();
    await expect(dialog).toContainText(root);
    expect(await page.evaluate(() => window.hikari!.workspace.recent())).toEqual([]);
    expect(await page.evaluate(() => window.hikari!.workspace.snapshot())).toBeNull();
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => ({
        canceled: true,
        filePaths: [],
      })) as typeof dialog.showOpenDialog;
    });
    await dialog.getByRole('button', { name: '更换文件夹', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '创建项目', exact: true })).toBeEnabled();
    await expect(dialog).toContainText(root);
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [root],
      })) as typeof dialog.showOpenDialog;
    }, root);
    await page.screenshot({ path: 'test-results/create-project-selected.png' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await nav.getByRole('button', { name: '新增项目', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: '项目名称' })).toHaveValue('');
    await expect(dialog.getByRole('button', { name: '创建项目', exact: true })).toBeDisabled();
    const bounds = await dialog.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(520);
    expect(bounds!.height).toBeLessThanOrEqual(380);
    expect(
      await dialog
        .locator('h2')
        .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeLessThanOrEqual(20);
    await page.screenshot({ path: 'test-results/create-project-empty.png' });
    await dialog.getByRole('button', { name: '添加文件夹', exact: true }).click();
    await dialog.getByRole('button', { name: '移除源文件夹', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '创建项目', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: '添加文件夹', exact: true }).click();
    await dialog.getByRole('textbox', { name: '项目名称' }).fill('My website');
    await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      nav.getByRole('button', { name: '打开项目 My website', exact: true }),
    ).toBeVisible();
    expect((await page.evaluate(() => window.hikari!.workspace.snapshot()))?.root).toBe(root);
    await page.evaluate(() => window.hikari!.preferences.set({ theme: 'dark', language: 'zh-CN' }));
    await page.reload();
    await page.setViewportSize({ width: 800, height: 600 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await nav.getByRole('button', { name: '新增项目', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'test-results/create-project-dark-compact.png' });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(dialog).not.toBeVisible();
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});

test('project header menu sorts chats and persists sidebar arrangement across reloads', async () => {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-project-menu-')));
  const root = path.join(data, 'website');
  await mkdir(root);
  const store = new LocalPersistence(path.join(data, 'hakari.sqlite'));
  const manager = new TaskManager();
  const first = manager.create('Created first', root);
  first.createdAt = '2026-10-01T00:00:00.000Z';
  first.updatedAt = '2026-10-03T00:00:00.000Z';
  const second = manager.create('Created second', root);
  second.createdAt = '2026-10-02T00:00:00.000Z';
  second.updatedAt = '2026-10-02T00:00:00.000Z';
  const otherRoot = path.join(data, 'other');
  await mkdir(otherRoot);
  const other = manager.create('Another project', otherRoot);
  other.updatedAt = '2026-09-30T00:00:00.000Z';
  const chat = manager.create('Standalone chat', 'chat://fixture');
  chat.chat = true;
  chat.updatedAt = '2026-09-29T00:00:00.000Z';
  const pinned = manager.create('Pinned chat', root);
  pinned.navigation = { pinned: true };
  const section = manager.create('Section chat', root);
  section.navigation = { section: 'Research' };
  for (const task of [first, second, other, chat, pinned, section]) {
    task.status = 'completed';
    store.task(task);
  }
  await store.close();
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    const page = await app.firstWindow();
    const nav = page.getByRole('navigation', { name: 'Conversations and projects' });
    const project = nav.getByRole('region', { name: root, exact: true });
    await expect(project.locator('.task-title')).toHaveText(['Created first', 'Created second']);
    const trigger = nav.getByRole('button', { name: 'Project list options', exact: true });
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Project list options', exact: true });
    await expect(menu.getByRole('menuitem')).toHaveText(['Organize sidebar', 'Chat sort order']);
    await page.screenshot({ path: 'test-results/project-header-menu.png' });
    await menu.getByRole('menuitem', { name: 'Chat sort order', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Manual order', exact: true }).click();
    const secondRow = project.locator('.task-button').filter({ hasText: 'Created second' });
    await secondRow.focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(project.locator('.task-title')).toHaveText(['Created second', 'Created first']);
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Organize sidebar', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Combined view', exact: true }).click();
    await expect(nav.locator('.project-group')).toHaveCount(0);
    await expect(nav.locator('.merged-tasks .task-title')).toHaveText([
      'Created second',
      'Created first',
      'Another project',
      'Standalone chat',
    ]);
    await page.reload();
    await expect(nav.locator('.merged-tasks .task-title')).toHaveText([
      'Created second',
      'Created first',
      'Another project',
      'Standalone chat',
    ]);
    await expect(nav.locator('.task-title')).toHaveCount(6);
    await expect(nav.getByRole('region', { name: 'Pinned', exact: true })).toContainText(
      'Pinned chat',
    );
    await expect(nav.getByRole('region', { name: 'Research', exact: true })).toContainText(
      'Section chat',
    );
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Chat sort order', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Recently updated', exact: true }).click();
    await expect(nav.locator('.merged-tasks .task-title')).toHaveText([
      'Created first',
      'Created second',
      'Another project',
      'Standalone chat',
    ]);
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Chat sort order', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Manual order', exact: true }).click();
    await expect(nav.locator('.merged-tasks .task-title')).toHaveText([
      'Created second',
      'Created first',
      'Another project',
      'Standalone chat',
    ]);
    await nav
      .locator('.merged-tasks .task-button')
      .filter({ hasText: 'Created first' })
      .dragTo(nav.locator('.merged-tasks .task-button').filter({ hasText: 'Created second' }), {
        targetPosition: { x: 20, y: 2 },
      });
    await expect(nav.locator('.merged-tasks .task-title')).toHaveText([
      'Created first',
      'Created second',
      'Another project',
      'Standalone chat',
    ]);
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Organize sidebar', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'By project', exact: true }).click();
    await expect(project.locator('.task-title')).toHaveText(['Created first', 'Created second']);
    await nav.getByRole('button', { name: 'Toggle projects', exact: true }).click();
    await expect(project).not.toBeVisible();
    await page.reload();
    await expect(nav.getByRole('button', { name: 'Toggle projects', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await page.keyboard.press('Tab');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await page.evaluate(() =>
      window.hikari!.preferences.set({ language: 'zh-CN', theme: 'light' }),
    );
    await page.reload();
    await page.getByRole('button', { name: '项目列表选项', exact: true }).click();
    await page.getByRole('menuitem', { name: '整理侧边栏', exact: true }).hover();
    await expect(
      page.getByRole('menuitemradio', { name: '分项目显示', exact: true }),
    ).toHaveAttribute('aria-checked', 'true');
    await page.screenshot({ path: 'test-results/sidebar-grouping-menu.png' });
    await page.getByRole('menuitem', { name: '聊天排序方式', exact: true }).hover();
    await expect(
      page.getByRole('menuitemradio', { name: '手动排序', exact: true }),
    ).toHaveAttribute('aria-checked', 'true');
    await page.screenshot({ path: 'test-results/sidebar-sort-menu.png' });
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});
