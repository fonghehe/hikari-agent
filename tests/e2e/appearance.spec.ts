import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test, expect, _electron as electron } from '@playwright/test';
import { LocalPersistence } from '../../apps/desktop/src/main/persistence';
import { TaskManager } from '../../packages/agent-runtime/src';
import { wideDesktopWindow } from './desktop-window';

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

test('Hikari restores legacy database history and preferences without replacing the database', async () => {
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
  } finally {
    await app.close();
  }
});

test('scrolling stays on panel edges at wide and narrow desktop sizes', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: /A little direction/ })).toBeVisible();
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
    await page.getByRole('button', { name: 'Appearance & language', exact: true }).click();
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.screenshot({ path: 'test-results/hikari-light-desktop.png' });
    for (let index = 0; index < 10; index++) {
      await page.evaluate((index) => window.hikari!.agent.start(`Layout fixture ${index}`), index);
    }
    await page.getByRole('button', { name: /New task/ }).click();
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
    await expect
      .poll(() =>
        page.locator('.welcome').evaluate((element) => element.scrollHeight > element.clientHeight),
      )
      .toBe(true);
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
    await page.getByRole('button', { name: '設定を閉じる' }).click();
    await page.getByRole('textbox', { name: 'タスクの指示', exact: true }).fill('你好');
    await page.getByRole('button', { name: 'タスクを開始', exact: true }).click();
    await expect(page.locator('[data-event-type="agent.completed"]')).toContainText('你好！');
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
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

test('directory tree expands, collapses, uses keyboard navigation and opens the correct nested file', async () => {
  await mkdir(path.join(directory, 'src/nested'), { recursive: true });
  await writeFile(path.join(directory, 'src/nested/index.ts'), 'export const treeFixture = true;');
  await writeFile(path.join(directory, 'src/app.ts'), 'export {};');
  await writeFile(path.join(directory, 'README.md'), '# Tree fixture');
  const app = await launch();
  try {
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [directory],
      })) as typeof dialog.showOpenDialog;
    }, directory);
    const page = await wideDesktopWindow(app);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    const tree = page.getByRole('tree', { name: 'File tree' });
    const src = tree.getByRole('treeitem', { name: 'src', exact: true });
    const nested = tree.getByRole('treeitem', { name: 'src/nested', exact: true });
    await expect(src).toHaveAttribute('aria-expanded', 'true');
    await expect(nested).toHaveText('nested1');
    await src.click();
    await expect(nested).toHaveCount(0);
    await src.press('ArrowRight');
    await expect(nested).toBeVisible();
    await src.press('ArrowRight');
    await expect(nested).toBeFocused();
    await nested.press('ArrowLeft');
    await expect(nested).toHaveAttribute('aria-expanded', 'false');
    await nested.press('ArrowLeft');
    await expect(src).toBeFocused();
    await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
    await expect(src).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Expand all', exact: true }).click();
    await tree.getByRole('treeitem', { name: 'src/nested/index.ts', exact: true }).click();
    await expect(page.locator('.monaco-editor')).toBeVisible();
    await expect(page.locator('.view-lines')).toContainText('treeFixture');
    await page.getByRole('button', { name: 'Appearance & language', exact: true }).click();
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
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
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 700));
    await expect(
      page.getByRole('button', { name: 'Toggle right panel', exact: true }),
    ).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
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
