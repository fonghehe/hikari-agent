import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalPersistence } from '../../apps/desktop/src/main/persistence';
import { TaskManager } from '../../packages/agent-runtime/src';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

test('custom sections lead the sidebar, remember collapse and own new chats and follow-ups', async () => {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-section-layout-')));
  const root = path.join(data, 'project');
  await mkdir(root);
  const persistence = new LocalPersistence(path.join(data, 'hakari.sqlite'));
  const manager = new TaskManager();
  const sectionTask = manager.create('Existing section conversation', 'chat://section');
  sectionTask.chat = true;
  sectionTask.navigation = { section: 'Research' };
  const projectTask = manager.create('Project conversation', root);
  const pinned = manager.create('Pinned chat', 'chat://pinned');
  pinned.chat = true;
  pinned.navigation = { pinned: true };
  for (const task of manager.list()) {
    task.status = 'completed';
    persistence.task(task);
  }
  await persistence.close();
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ choices: [{ message: { content: 'Section fixture answer.' } }] }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    const page = await app.firstWindow();
    await page.evaluate(
      (baseUrl) =>
        window.hikari!.agent.configure({
          provider: 'compatible',
          model: 'section-fixture',
          baseUrl,
          apiKey: '',
          streaming: false,
        }),
      `http://127.0.0.1:${address.port}/v1`,
    );
    await page.reload();
    const nav = page.getByRole('navigation', { name: 'Conversations and projects' });
    const section = nav.getByRole('region', { name: 'Research', exact: true });
    const toggle = section.getByRole('button', { name: 'Toggle section Research', exact: true });
    await expect(section).toContainText(sectionTask.title);
    await expect(nav.getByRole('region', { name: root, exact: true })).toContainText(
      projectTask.title,
    );
    expect(
      await nav.evaluate((element) =>
        element.firstElementChild?.classList.contains('custom-section'),
      ),
    ).toBe(true);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(
      section.getByRole('button', { name: new RegExp(`^${sectionTask.title}`) }),
    ).toHaveCount(0);
    await page.reload();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('textbox', { name: 'Search tasks', exact: true }).fill('Existing section');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(
      section.getByRole('button', { name: new RegExp(`^${sectionTask.title}`) }),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'Search tasks', exact: true }).fill('');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await section
      .getByRole('button', { name: 'New chat in section Research', exact: true })
      .click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.composer-section')).toHaveText('Research');
    await page.getByRole('textbox', { name: 'Task prompt', exact: true }).fill('Section question');
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(
      section.locator('.task-button').filter({ hasText: 'Section question' }),
    ).toHaveCount(1);
    await expect(nav.getByRole('region', { name: 'Recent', exact: true })).not.toContainText(
      'Section question',
    );
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.hikari!.agent.list())).find(
            (task) => task.prompt === 'Section question',
          )?.status,
      )
      .toBe('completed');
    await page
      .getByRole('textbox', { name: 'Follow-up prompt', exact: true })
      .fill('Section follow-up');
    await page.getByRole('button', { name: 'Send follow-up', exact: true }).click();
    await expect(
      section.locator('.task-button').filter({ hasText: 'Section follow-up' }),
    ).toHaveCount(1);
    const followUp = (await page.evaluate(() => window.hikari!.agent.list())).find(
      (task) => task.prompt === 'Section follow-up',
    );
    expect(followUp?.navigation?.section).toBe('Research');
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.hikari!.agent.list())).find(
            (task) => task.id === followUp?.id,
          )?.status,
      )
      .toBe('completed');
    await page.reload();
    await expect(section.locator('.task-button')).toHaveCount(3);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: /^New task ⌘ N$/ }).click();
    await expect(page.locator('.composer-section')).toHaveCount(0);
    await page
      .getByRole('textbox', { name: 'Task prompt', exact: true })
      .fill('Unsectioned question');
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(nav.getByRole('region', { name: 'Recent', exact: true })).toContainText(
      'Unsectioned question',
    );
    await expect(page.locator('.global-error')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/sidebar-top-sections.png' });
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});

test('remote controls have separation and native fields use shared widths across dialogs and panels', async () => {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-global-fields-')));
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
    const initialBounds = await settings.boundingBox();
    await settings.getByRole('tab', { name: '自动化与集成', exact: true }).click();
    await settings.getByText('远程控制', { exact: true }).click();
    const remote = settings
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: '远程控制' }) });
    await remote.scrollIntoViewIfNeeded();
    const paragraph = await remote.locator(':scope > p').boundingBox();
    const label = await remote
      .getByLabel('允许局域网连接', { exact: true })
      .locator('..')
      .boundingBox();
    const button = await remote
      .getByRole('button', { name: '开启远程控制', exact: true })
      .boundingBox();
    expect(label!.y - paragraph!.y - paragraph!.height).toBeGreaterThanOrEqual(12);
    expect(button!.y - label!.y - label!.height).toBeGreaterThanOrEqual(14);
    expect(await settings.boundingBox()).toEqual(initialBounds);
    await page.screenshot({ path: 'test-results/remote-control-spacing.png' });
    await settings.getByText('定时任务', { exact: true }).click();
    const schedule = settings
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: '定时任务' }) });
    expect(
      (await schedule.getByLabel('重复间隔（分钟）', { exact: true }).boundingBox())!.width,
    ).toBeLessThanOrEqual(128);
    expect(
      (await schedule.getByLabel('通知', { exact: true }).boundingBox())!.width,
    ).toBeLessThanOrEqual(360);
    await settings.getByRole('tab', { name: '扩展', exact: true }).click();
    expect(
      (await settings.getByLabel('服务名称', { exact: true }).boundingBox())!.width,
    ).toBeLessThanOrEqual(340);
    expect(
      (await settings.getByLabel('连接方式', { exact: true }).boundingBox())!.width,
    ).toBeLessThan(300);
    await page.screenshot({ path: 'test-results/settings-content-widths.png' });
    await settings.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '任务选项', exact: true }).click();
    const options = page.getByRole('dialog', { name: '任务选项', exact: true });
    expect(
      (await options.locator('input[type="number"]').first().boundingBox())!.width,
    ).toBeLessThanOrEqual(128);
    expect((await options.getByRole('combobox').first().boundingBox())!.width).toBeLessThan(360);
    await options.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    const model = page.getByRole('dialog');
    const width = await model
      .locator('input[type="password"]')
      .first()
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(width).toBeLessThanOrEqual(440);
    expect((await model.getByRole('combobox').first().boundingBox())!.width).toBeLessThanOrEqual(
      360,
    );
    await model.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '账户与同步', exact: true }).click();
    const sync = page.locator('.sync-panel');
    await expect(sync).toBeVisible();
    expect((await sync.locator('input[type="email"]').boundingBox())!.width).toBeLessThanOrEqual(
      440,
    );
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});
