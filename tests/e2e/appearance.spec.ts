import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test, expect, _electron as electron } from '@playwright/test';
import { LocalPersistence } from '../../apps/desktop/src/main/persistence';
import { TaskManager } from '../../packages/agent-runtime/src';
import { wideDesktopWindow, openWorkspaceTool, addWorkspaceProject } from './desktop-window';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
let directory: string;
test.beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'forge-appearance-'));
});
test.afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const launch = () =>
  electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: directory },
  });

test('Hikari migrates legacy history and preferences to hakari.sqlite while preserving the source', async () => {
  const store = new LocalPersistence(path.join(directory, 'forge.sqlite'));
  const task = new TaskManager().create('Legacy task history', directory);
  task.status = 'completed';
  store.task(task);
  store.save('model_configs', 'app-preferences', { theme: 'light', language: 'zh-CN' });
  await store.close();
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: '', FORGE_DATA_DIR: directory },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.locator('.task-button')).toContainText('Legacy task history');
    expect(await page.evaluate(() => typeof window.forge?.workspace.open)).toBe('function');
    expect((await page.evaluate(() => window.hikari!.agent.list()))[0]!.id).toBe(task.id);
    expect(existsSync(path.join(directory, 'hakari.sqlite'))).toBe(true);
    expect(existsSync(path.join(directory, 'forge.sqlite'))).toBe(true);
  } finally {
    await app.close();
  }
});

test('sidebar lists projects directly with one settings entry and room for task history', async () => {
  const store = new LocalPersistence(path.join(directory, 'hakari.sqlite'));
  const tasks = new TaskManager();
  for (let index = 0; index < 25; index++) {
    const task = tasks.create(`Sidebar task ${index} with a long descriptive title`, directory);
    task.status = 'completed';
    store.task(task);
  }
  await store.close();
  const app = await launch();
  try {
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, directory);
    const page = await app.firstWindow();
    const sidebar = page.locator('.sidebar');
    await expect(
      sidebar.getByRole('button', { name: 'Project list options', exact: true }),
    ).toHaveCount(1);
    await expect(sidebar.locator('.workspace-switcher')).toHaveCount(0);
    await expect(sidebar.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(1);
    await expect(
      sidebar.getByRole('button', { name: 'Appearance & language', exact: true }),
    ).toHaveCount(0);
    await expect(sidebar.locator('select')).toHaveCount(0);
    await addWorkspaceProject(page);
    const project = sidebar.getByRole('button', {
      name: `Open project ${path.basename(directory)}`,
      exact: true,
    });
    await expect(project).toBeVisible();
    await sidebar
      .getByRole('button', { name: `New task in ${path.basename(directory)}`, exact: true })
      .click();
    await expect(project).toHaveAttribute('aria-current', 'true');
    await expect(sidebar.locator('.project-group')).toHaveCount(1);
    await expect(sidebar.locator('.project-tasks .task-button')).toHaveCount(25);
    for (const width of [1480, 1000]) {
      await page.setViewportSize({ width, height: 700 });
      const layout = await sidebar.evaluate((element) => {
        const list = element.querySelector('.task-list')!;
        const settings = element.querySelector('.sidebar-settings')!;
        return {
          space: list.clientHeight >= window.innerHeight * 0.4,
          separated: list.getBoundingClientRect().bottom <= settings.getBoundingClientRect().top,
          scrolls: list.scrollHeight > list.clientHeight,
        };
      });
      expect(layout).toEqual({ space: true, separated: true, scrolls: true });
    }
    await sidebar.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(
      sidebar
        .locator('.sidebar-settings')
        .getByRole('button', { name: 'Data & updates', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sidebar.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
    await expect(sidebar.locator('.sidebar-settings')).not.toHaveAttribute('open');
    await sidebar.getByRole('button', { name: 'Settings', exact: true }).press('Enter');
    await sidebar.getByRole('button', { name: 'Appearance & language', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Appearance & language', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Task history', exact: true }).click();
    await expect(page.locator('.history-row')).toHaveCount(25);
    await page.screenshot({ path: 'test-results/sidebar-consolidated.png' });
  } finally {
    await app.close();
  }
});

test('scrolling stays on panel edges at wide and narrow desktop sizes', async () => {
  const app = await launch();
  try {
    const page = await wideDesktopWindow(app);
    await expect(
      page.getByRole('heading', { name: 'What would you like to work on?', exact: true }),
    ).toBeVisible();
    expect(await app.evaluate(({ app }) => app.getName())).toBe('Hikari');
    await expect(page.locator('.brand')).toContainText('hikari');
    const right = async (selector: string) =>
      page.locator(selector).evaluate((element) => element.getBoundingClientRect().right);
    expect(Math.abs((await right('.welcome')) - (await right('main')))).toBeLessThan(2);
    expect(Math.abs((await right('.task-list')) - (await right('.sidebar')))).toBeLessThan(2);
    expect(Math.abs((await right('.inspector-body')) - (await right('.inspector')))).toBeLessThan(
      2,
    );
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1480, 760));
    await page.screenshot({ path: 'test-results/hikari-dark-desktop.png' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance & language', exact: true }).click();
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.screenshot({ path: 'test-results/hikari-light-desktop.png' });
    for (let index = 0; index < 25; index++) {
      await page.evaluate((index) => window.hikari!.agent.start(`Layout fixture ${index}`), index);
    }
    await page.getByRole('button', { name: /^New task ⌘ N$/ }).click();
    await expect
      .poll(() =>
        page
          .locator('.task-list')
          .evaluate((element) => element.scrollHeight > element.clientHeight),
      )
      .toBe(true);
    expect(Math.abs((await right('.task-list')) - (await right('.sidebar')))).toBeLessThan(2);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 700));
    expect(Math.abs((await right('.welcome')) - (await right('main')))).toBeLessThan(2);
    // The compact welcome screen fits without scrolling through configuration fields.
    await expect(page.getByRole('button', { name: 'Start task', exact: true })).toBeInViewport();
    await page.locator('.welcome').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.getByRole('button', { name: 'Start task', exact: true })).toBeInViewport();
    await page.screenshot({ path: 'test-results/hikari-narrow.png' });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test('appearance and three interface languages apply immediately and survive restart', async () => {
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance & language', exact: true }).click();
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
    await expect(page.getByRole('dialog', { name: '外观与语言' })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建任务', exact: false })).toBeVisible();
    await page.screenshot({ path: 'test-results/appearance-light-zh.png' });
    await page.getByLabel('语言', { exact: true }).selectOption('ja');
    await expect(page.getByRole('dialog', { name: '外観と言語' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await page.getByRole('button', { name: '閉じる' }).click();
    await page.getByRole('textbox', { name: 'タスクの指示', exact: true }).fill('你好');
    await page.getByRole('button', { name: 'タスクを開始', exact: true }).click();
    await expect(page.locator('[data-event-type="agent.completed"]')).toContainText('你好！');
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await page.getByRole('button', { name: '外観と言語', exact: true }).click();
    await page.getByLabel('言語', { exact: true }).selectOption('en');
    await page.getByRole('button', { name: 'System', exact: true }).click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: 'test-results/appearance-dark-en.png' });
    expect(await page.evaluate(() => window.hikari!.preferences.get())).toEqual({
      theme: 'dark',
      language: 'en',
    });
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('conversation starts with minimal controls and opens optional tools only on demand', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const panel = page.getByRole('complementary', { name: 'Right panel' });
    await expect(panel).toBeHidden();
    await expect(page.getByLabel('Agent mode')).toHaveCount(0);
    await expect(page.getByLabel('Maximum model turns')).toHaveCount(0);
    await expect(page.getByLabel('Isolate in a Git worktree')).toHaveCount(0);
    await expect(page.getByText('Acceptance and budgets', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'browser', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Account & sync', exact: true })).toBeHidden();
    const options = page.getByRole('button', { name: 'Task options', exact: true });
    await options.click();
    const dialog = page.getByRole('dialog', { name: 'Task options', exact: true });
    await expect(dialog).toBeVisible();
    await page.getByLabel('Maximum model turns').fill('12');
    await page.getByLabel('Agent mode').selectOption('plan');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(options).toBeFocused();
    await options.click();
    await expect(page.getByLabel('Maximum model turns')).toHaveValue('12');
    await expect(page.getByLabel('Agent mode')).toHaveValue('plan');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: /^New task ⌘ N$/ }).click();
    await options.click();
    await expect(page.getByLabel('Maximum model turns')).toHaveValue('30');
    await expect(page.getByLabel('Agent mode')).toHaveValue('execute');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await openWorkspaceTool(page, 'browser');
    await expect(panel).toContainText('Select a task to see its browser.');
    await expect(panel.locator('.tab')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await expect(panel).toBeHidden();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Account & sync', exact: true }).click();
    const sync = page.getByRole('dialog', { name: 'Account & sync', exact: true });
    await expect(sync).toBeVisible();
    await expect(panel).toBeHidden();
    await sync.getByRole('button', { name: 'Close', exact: true }).click();
    for (const width of [1480, 1000]) {
      await page.setViewportSize({ width, height: 700 });
      await expect(page.getByRole('button', { name: 'Start task', exact: true })).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: `test-results/minimal-workspace-${width}.png` });
    }
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('long workspace names and task titles keep controls separated at compact widths', async () => {
  const root = path.join(directory, 'workspace-with-a-long-name-用于验证边距和工具栏间距');
  await mkdir(root);
  await writeFile(path.join(root, 'README.md'), '# Layout fixture');
  const store = new LocalPersistence(path.join(directory, 'hakari.sqlite'));
  const task = new TaskManager().create(
    'Read this repository and explain the architecture · 验证长任务标题不会挤压右侧操作按钮',
    root,
  );
  task.status = 'completed';
  task.events.push({
    id: 'spacing-result',
    agentId: 'spacing-agent',
    taskId: task.id,
    timestamp: new Date().toISOString(),
    type: 'agent.completed',
    data: { text: 'Spacing fixture response.' },
  });
  store.task(task);
  await store.close();
  const app = await launch();
  try {
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, root);
    const page = await app.firstWindow();
    await addWorkspaceProject(page);
    for (const width of [1480, 1000, 740]) {
      await page.setViewportSize({ width, height: 700 });
      const measureComposer = () =>
        page.locator('.composer').evaluate((composer) => {
          const bounds = composer.getBoundingClientRect();
          const context = composer.querySelector('.composer-context')!.getBoundingClientRect();
          const actions = composer.querySelector('.composer-actions')!.getBoundingClientRect();
          const buttons = [...composer.querySelectorAll('.composer-actions > button')].map(
            (button) => button.getBoundingClientRect(),
          );
          return {
            inside:
              context.left >= bounds.left + 12 &&
              actions.right <= bounds.right - 12 &&
              actions.bottom <= bounds.bottom - 12,
            separated: actions.left >= context.right + 12 || actions.top >= context.bottom + 12,
            aligned: buttons.every(
              (button) =>
                Math.abs(
                  button.top + button.height / 2 - (buttons[0]!.top + buttons[0]!.height / 2),
                ) < 2,
            ),
            gaps: buttons
              .slice(1)
              .every((button, index) => button.left - buttons[index]!.right >= 7),
          };
        });
      await expect
        .poll(measureComposer)
        .toEqual({ inside: true, separated: true, aligned: true, gaps: true });
      await page.locator('.task-button').first().click();
      await expect(page.locator('[data-event-type="agent.completed"]')).toBeVisible();
      await expect
        .poll(() =>
          page.locator('header').evaluate((header) => {
            const breadcrumb = header.querySelector('.breadcrumb')!.getBoundingClientRect();
            const actions = header.querySelector('.header-actions')!.getBoundingClientRect();
            return (
              actions.left >= breadcrumb.right + 12 &&
              actions.right <= header.getBoundingClientRect().right - 16 &&
              actions.right >= header.getBoundingClientRect().right - 32
            );
          }),
        )
        .toBe(true);
      await expect
        .poll(measureComposer)
        .toEqual({ inside: true, separated: true, aligned: true, gaps: true });
      const heading = await page.locator('.conversation-view .task-heading').evaluate((heading) => {
        const title = heading.querySelector('h2')!.getBoundingClientRect();
        const actions = heading.querySelector('.actions')!.getBoundingClientRect();
        return actions.left >= title.right + 12 || actions.top >= title.bottom + 12;
      });
      expect(heading).toBe(true);
      await page.getByRole('button', { name: 'Task options', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Task options' });
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(Math.abs(bounds!.x + bounds!.width / 2 - width / 2)).toBeLessThan(2);
      expect(Math.abs(bounds!.y + bounds!.height / 2 - 350)).toBeLessThan(2);
      await page.getByText('Acceptance and budgets', { exact: true }).click();
      await expect
        .poll(() =>
          dialog.evaluate((dialog) => {
            const bounds = dialog.getBoundingClientRect();
            return (
              bounds.top >= 20 &&
              bounds.bottom <= window.innerHeight - 20 &&
              dialog.scrollWidth <= dialog.clientWidth
            );
          }),
        )
        .toBe(true);
      await page.screenshot({ path: `test-results/spacing-options-${width}.png` });
      await page.keyboard.press('Escape');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: `test-results/spacing-conversation-${width}.png` });
      await page.getByRole('button', { name: /^New task ⌘ N$/ }).click();
    }
  } finally {
    await app.close();
  }
});

test('directory tree expands, collapses, uses keyboard navigation and opens the correct nested file', async () => {
  await mkdir(path.join(directory, 'src/nested'), { recursive: true });
  await writeFile(path.join(directory, 'src/nested/index.ts'), 'export const treeFixture = true;');
  await writeFile(path.join(directory, 'src/app.ts'), 'export {};');
  await writeFile(path.join(directory, 'README.md'), '# Tree fixture');
  await mkdir(path.join(directory, '.turbo/cache'), { recursive: true });
  await writeFile(path.join(directory, '.turbo/cache/entry.json'), '{}');
  await mkdir(path.join(directory, 'dist'), { recursive: true });
  await writeFile(path.join(directory, 'dist/app.js'), '/* generated */');
  const app = await launch();
  try {
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [directory],
      })) as typeof dialog.showOpenDialog;
    }, directory);
    const page = await wideDesktopWindow(app);
    await addWorkspaceProject(page);
    const tree = page.getByRole('tree', { name: 'File tree' });
    const src = tree.getByRole('treeitem', { name: 'src', exact: true });
    const nested = tree.getByRole('treeitem', { name: 'src/nested', exact: true });
    await expect(src).toHaveAttribute('aria-expanded', 'false');
    await expect(nested).toHaveCount(0);
    await src.press('ArrowRight');
    await expect(nested).toBeVisible();
    await expect(nested).toHaveText('nested1');
    await expect(nested).toHaveAttribute('aria-expanded', 'false');
    await src.press('ArrowRight');
    await expect(nested).toBeFocused();
    await nested.press('ArrowRight');
    await expect(
      tree.getByRole('treeitem', { name: 'src/nested/index.ts', exact: true }),
    ).toBeVisible();
    await nested.press('ArrowLeft');
    await expect(nested).toHaveAttribute('aria-expanded', 'false');
    await nested.press('ArrowLeft');
    await expect(src).toBeFocused();
    await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
    await expect(src).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Expand one level', exact: true }).click();
    await expect(tree.getByRole('treeitem', { name: '.turbo', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(tree.getByRole('treeitem', { name: 'dist', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(nested).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Expand one level', exact: true }).click();
    await tree.getByRole('treeitem', { name: 'src/nested/index.ts', exact: true }).click();
    await expect(page.locator('.monaco-editor')).toBeVisible();
    await expect(page.locator('.view-lines')).toContainText('treeFixture');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance & language', exact: true }).click();
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('.monaco-editor')).toHaveClass(/\bvs\b/);
    await page.screenshot({ path: 'test-results/tree-light.png' });
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('wide-layout setup restores the panel after a small native desktop closes it', async () => {
  await mkdir(path.join(directory, 'src'));
  await writeFile(path.join(directory, 'src/index.ts'), 'export {};');
  const app = await launch();
  try {
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [directory],
      })) as typeof dialog.showOpenDialog;
    }, directory);
    const page = await wideDesktopWindow(app);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 700));
    // Xvfb's native resize may arrive during renderer startup. Drive a real CSS
    // viewport transition after the UI is ready, independent of the window manager.
    await page.setViewportSize({ width: 1000, height: 700 });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1000);
    await expect(
      page.getByRole('button', { name: 'Toggle right panel', exact: true }),
    ).toHaveAttribute('aria-expanded', 'false');
    await addWorkspaceProject(page);
    // The tree exists, but role queries correctly exclude the collapsed panel.
    await expect(
      page.getByRole('treeitem', { name: 'src', exact: true, includeHidden: true }),
    ).toHaveCount(1);
    await expect(page.getByRole('treeitem', { name: 'src', exact: true })).toHaveCount(0);
    await wideDesktopWindow(app);
    await expect(
      page.getByRole('complementary', { name: 'Right panel', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'src', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.innerWidth)).toBe(1480);
  } finally {
    await app.close();
  }
});
