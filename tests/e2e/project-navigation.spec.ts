import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalPersistence } from '../../apps/desktop/src/main/persistence';
import { TaskManager } from '../../packages/agent-runtime/src';
import { runOptionsSchema } from '../../packages/agent-core/src';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

test('projects own their chats across direct switching, follow-ups, search and reload', async () => {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-project-navigation-')));
  const alpha = path.join(data, 'alpha');
  const beta = path.join(data, 'beta');
  await mkdir(alpha);
  await mkdir(beta);
  const store = new LocalPersistence(path.join(data, 'hakari.sqlite'));
  const manager = new TaskManager();
  const first = manager.create('Alpha question', alpha);
  const second = manager.create('Beta question', beta);
  const chat = manager.create('General conversation', 'chat://hikari/fixture');
  chat.chat = true;
  for (const task of [first, second, chat]) {
    task.status = 'completed';
    task.runOptions = runOptionsSchema.parse({ mode: 'plan', requireTests: false });
    store.task(task);
  }
  await store.close();
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: 'Fixture answer.' } }] }));
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
          model: 'project-navigation-fixture',
          apiKey: '',
          baseUrl,
          streaming: false,
        }),
      `http://127.0.0.1:${address.port}/v1`,
    );
    await page.reload();
    const nav = page.getByRole('navigation', { name: 'Conversations and projects' });
    const alphaGroup = nav.getByRole('region', { name: alpha, exact: true });
    const betaGroup = nav.getByRole('region', { name: beta, exact: true });
    const chats = nav.getByRole('region', { name: 'Recent', exact: true });
    await expect(alphaGroup.locator('.task-button')).toContainText('Alpha question');
    await expect(betaGroup.locator('.task-button')).toContainText('Beta question');
    await expect(chats.locator('.task-button')).toHaveCount(1);
    await expect(chats).toContainText('General conversation');
    await expect(nav.locator('select, .workspace-switcher')).toHaveCount(0);
    expect(
      await nav.evaluate((element) => {
        const project = element.querySelector('.project-group')!;
        const recent = element.querySelector('.chat-group')!;
        return project.getBoundingClientRect().top < recent.getBoundingClientRect().top;
      }),
    ).toBe(true);

    await alphaGroup.getByRole('button', { name: 'New task in alpha', exact: true }).click();
    await expect(page.locator('.composer-bottom')).toContainText('alpha');
    await page.evaluate(() => {
      const label = document.querySelector('.composer-project-trigger')!;
      const samples: string[] = [];
      new MutationObserver(() => samples.push(label.textContent ?? '')).observe(label, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      Reflect.set(window, 'workspaceLabelSamples', samples);
    });
    for (let index = 0; index < 4; index++)
      await alphaGroup.getByRole('button', { name: 'New task in alpha', exact: true }).click();
    expect(await page.evaluate(() => Reflect.get(window, 'workspaceLabelSamples'))).toEqual([]);
    await page.getByRole('button', { name: 'Task options', exact: true }).click();
    await page.getByLabel('Agent mode', { exact: true }).selectOption('plan');
    await page
      .getByRole('dialog', { name: 'Task options' })
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'Task prompt', exact: true })
      .fill('Alpha new question');
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(alphaGroup.locator('.task-button')).toHaveCount(2);
    await expect(page.locator('.task-view')).toContainText('Fixture answer.');

    await betaGroup.getByRole('button', { name: 'New task in beta', exact: true }).click();
    await expect(page.locator('.composer-bottom')).toContainText('beta');
    await alphaGroup.locator('.task-button').filter({ hasText: 'Alpha question' }).click();
    await page
      .getByRole('textbox', { name: 'Follow-up prompt', exact: true })
      .fill('Alpha follow-up');
    await page.getByRole('button', { name: 'Send follow-up', exact: true }).click();
    await expect(alphaGroup.locator('.task-button')).toHaveCount(3);
    const followUp = await page.evaluate(async () =>
      (await window.hikari!.agent.list()).find((task) => task.prompt === 'Alpha follow-up'),
    );
    expect(followUp?.workspace).toBe(alpha);
    expect(followUp?.parentTaskId).toBe(first.id);
    await expect(page.locator('.task-view')).toContainText('Fixture answer.');

    await nav.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select project', exact: true })).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Task prompt', exact: true })
      .fill('Another general conversation');
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(chats.locator('.task-button')).toHaveCount(2);
    const general = await page.evaluate(async () =>
      (await window.hikari!.agent.list()).find(
        (task) => task.prompt === 'Another general conversation',
      ),
    );
    expect(general?.chat).toBe(true);
    await expect(alphaGroup.locator('.task-button')).toHaveCount(3);

    await page.getByRole('textbox', { name: 'Search tasks', exact: true }).fill('Alpha follow-up');
    await expect(nav.locator('.task-button')).toHaveCount(1);
    await expect(alphaGroup).toContainText('Alpha follow-up');
    await page.getByRole('textbox', { name: 'Search tasks', exact: true }).fill('');
    await page.reload();
    await expect(alphaGroup.locator('.task-button')).toHaveCount(3);
    await expect(betaGroup.locator('.task-button')).toHaveCount(1);
    await expect(chats.locator('.task-button')).toHaveCount(2);
    await expect(page.locator('.global-error')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/project-navigation.png' });
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});

test('project editing, removal and file or folder imports preserve history without duplicates', async () => {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-project-lifecycle-')));
  const root = path.join(data, 'website');
  const alias = path.join(data, 'linked-website');
  const other = path.join(data, 'another-project');
  const file = path.join(root, 'README.md');
  await mkdir(root);
  await mkdir(other);
  await writeFile(file, '# Retained project files');
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const store = new LocalPersistence(path.join(data, 'hakari.sqlite'));
  const task = new TaskManager().create('Retained project conversation', alias);
  task.status = 'completed';
  store.task(task);
  store.save('workspaces', alias, { root: alias, name: 'website' });
  store.save('workspaces', root, { root, name: 'website' });
  await store.close();
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    await app.evaluate(
      ({ dialog }, { alias, file }) => {
        dialog.showOpenDialog = (async (...args: unknown[]) => {
          const options = args.at(-1) as { properties: string[] };
          return {
            canceled: false,
            filePaths: [options.properties.includes('openFile') ? file : alias],
          };
        }) as typeof dialog.showOpenDialog;
      },
      { alias, file },
    );
    const page = await app.firstWindow();
    const nav = page.getByRole('navigation', { name: 'Conversations and projects' });
    const project = nav.getByRole('region', { name: root, exact: true });
    await expect(nav.locator('.project-group')).toHaveCount(1);
    await expect(project.locator('.task-button')).toContainText(task.title);
    await project.locator('.project-row').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit project', exact: true });
    await edit.getByRole('textbox', { name: 'Project name', exact: true }).fill('Renamed website');
    await edit.getByRole('button', { name: 'Save project', exact: true }).click();
    await expect(
      project.getByRole('button', { name: 'Open project Renamed website', exact: true }),
    ).toBeVisible();
    const add = page.getByRole('dialog', { name: 'Create project', exact: true });
    for (const path of [file, alias, root]) {
      await nav.getByRole('button', { name: 'Add project', exact: true }).click();
      await add.getByLabel('Source options', { exact: true }).click();
      await add.getByRole('button', { name: 'Enter a path', exact: true }).click();
      await add.getByRole('textbox', { name: 'File or folder path', exact: true }).fill(path);
      await add.getByRole('button', { name: 'Create project', exact: true }).click();
      await expect(add).not.toBeVisible();
      await expect(nav.locator('.project-group')).toHaveCount(1);
    }
    await project.locator('.project-row').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove project', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Remove project?', exact: true });
    await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await expect(nav.locator('.project-group')).toHaveCount(1);
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(nav.locator('.project-group')).toHaveCount(1);
    await project.locator('.project-row').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await edit.getByRole('button', { name: 'Remove project', exact: true }).click();
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Remove project', exact: true }).click();
    await expect(nav.locator('.project-group')).toHaveCount(0);
    await expect(nav.locator('.task-button')).toHaveCount(0);
    const retained = await page.evaluate(
      async (id) => (await window.hikari!.agent.list()).find((task) => task.id === id),
      task.id,
    );
    expect(retained?.workspace).toBe(alias);
    expect(retained?.status).toBe('completed');
    await nav.getByRole('button', { name: 'Task history', exact: true }).click();
    await expect(page.locator('.history-row')).toContainText(task.title);
    await page.reload();
    await expect(nav.locator('.project-group')).toHaveCount(0);
    await nav.getByRole('button', { name: 'Add project', exact: true }).click();
    await add.getByLabel('Source options', { exact: true }).click();
    await add.getByRole('button', { name: 'Choose file', exact: true }).click();
    await add.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(project.locator('.task-button')).toContainText(task.title);
    await expect(nav.locator('.project-group')).toHaveCount(1);
    await expect(
      project.getByRole('button', { name: 'Open project Renamed website', exact: true }),
    ).toBeVisible();
    await nav.getByRole('button', { name: 'Add project', exact: true }).click();
    await add.getByRole('button', { name: 'Add folder', exact: true }).click();
    await add.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(add).not.toBeVisible();
    await expect(nav.locator('.project-group')).toHaveCount(1);
    await nav.getByRole('button', { name: 'Add project', exact: true }).click();
    await add.getByLabel('Source options', { exact: true }).click();
    await add.getByRole('button', { name: 'Enter a path', exact: true }).click();
    await add.getByRole('textbox', { name: 'File or folder path', exact: true }).fill(other);
    await add.getByRole('textbox', { name: 'Project name', exact: true }).fill('Another project');
    await add.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(nav.locator('.project-group')).toHaveCount(2);
    await expect(
      nav.getByRole('button', { name: 'Open project Another project', exact: true }),
    ).toBeVisible();
    await nav.getByRole('button', { name: 'Add project', exact: true }).click();
    await add.getByRole('textbox', { name: 'Project name', exact: true }).fill('Picked website');
    await add.getByLabel('Source options', { exact: true }).click();
    await add.getByRole('button', { name: 'Choose file', exact: true }).click();
    await add.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(add).not.toBeVisible();
    await expect(
      project.getByRole('button', { name: 'Open project Picked website', exact: true }),
    ).toBeVisible();
    await expect(nav.locator('.project-group')).toHaveCount(2);
    await page.screenshot({ path: 'test-results/project-management.png' });
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});

test('Codex project rows distinguish same names and expose keyboard-accessible context actions', async () => {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-codex-projects-')));
  const monorepo = path.join(data, 'turborepo-demo', 'vue-h5-template');
  const template = path.join(data, 'vue-h5-template', 'vue-h5-template');
  await mkdir(monorepo, { recursive: true });
  await mkdir(template, { recursive: true });
  const store = new LocalPersistence(path.join(data, 'hakari.sqlite'));
  const manager = new TaskManager();
  const first = manager.create('同步优化', monorepo);
  const second = manager.create('模板问题', template);
  for (const task of [first, second]) {
    task.status = 'completed';
    store.task(task);
    store.save('workspaces', task.workspace, { root: task.workspace, name: 'vue-h5-template' });
  }
  await store.close();
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    const page = await app.firstWindow();
    await page.evaluate(() =>
      window.hikari!.preferences.set({ theme: 'light', language: 'zh-CN' }),
    );
    await page.reload();
    const nav = page.getByRole('navigation', { name: '对话与项目' });
    const project = nav.getByRole('region', { name: monorepo, exact: true });
    const other = nav.getByRole('region', { name: template, exact: true });
    await expect(nav.locator('.project-group')).toHaveCount(2);
    await expect(project.locator('.project-location')).toHaveText('turborepo-demo');
    await expect(other.locator('.project-location')).toHaveText('vue-h5-template');
    await expect(project.locator('.project-settings')).toHaveCount(0);
    const folder = project.getByRole('button', {
      name: '打开项目 vue-h5-template · turborepo-demo',
      exact: true,
    });
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(project.locator('.task-button')).toHaveCount(0);
    await folder.click();
    await expect(project.locator('.task-button')).toContainText('同步优化');
    await page.setViewportSize({ width: 1000, height: 700 });
    const panelToggle = page.getByRole('button', { name: '切换右侧面板', exact: true });
    await expect(panelToggle).toHaveAttribute('aria-expanded', 'false');
    await panelToggle.click();
    await folder.press('Shift+F10');
    await expect(page.getByRole('menu', { name: '项目操作', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panelToggle).toHaveAttribute('aria-expanded', 'true');
    await panelToggle.click();
    await page.setViewportSize({ width: 1480, height: 960 });
    await project.locator('.project-row').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: '项目操作', exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText([
      '置顶',
      '编辑',
      '分区',
      '归档聊天',
      '移除项目',
    ]);
    await expect(menu.getByRole('menuitem', { name: '置顶', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: '编辑', exact: true })).toBeFocused();
    await page.screenshot({ path: 'test-results/codex-project-context-menu.png' });
    await page.keyboard.press('Escape');
    await expect(folder).toBeFocused();
    await folder.press('Shift+F10');
    await menu.getByRole('menuitem', { name: '置顶', exact: true }).click();
    await expect(
      nav
        .getByRole('region', { name: '置顶', exact: true })
        .getByRole('region', { name: monorepo, exact: true }),
    ).toBeVisible();
    await project.locator('.project-row').click({ button: 'right' });
    await menu.getByRole('menuitem', { name: '分区', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await page.getByRole('menuitem', { name: '新建分区…', exact: true }).click();
    const sectionDialog = page.getByRole('dialog', { name: '新建分区…', exact: true });
    await sectionDialog.getByRole('textbox', { name: '分区名称', exact: true }).fill('工作');
    await sectionDialog.getByRole('button', { name: '移动项目', exact: true }).click();
    await expect(
      nav
        .getByRole('region', { name: '工作', exact: true })
        .getByRole('region', { name: monorepo, exact: true }),
    ).toBeVisible();
    await expect(nav.getByRole('region', { name: '置顶', exact: true })).toHaveCount(0);
    await project.locator('.project-row').click({ button: 'right' });
    await menu.getByRole('menuitem', { name: '归档聊天', exact: true }).click();
    await expect(project.locator('.task-button')).toHaveCount(0);
    await expect(other.locator('.task-button')).toHaveCount(1);
    const saved = await page.evaluate(() => window.hikari!.agent.list());
    expect(saved.find((task) => task.id === first.id)?.archived).toBe(true);
    expect(saved.find((task) => task.id === second.id)?.archived).toBeFalsy();
    await page.reload();
    await expect(
      nav
        .getByRole('region', { name: '工作', exact: true })
        .getByRole('region', { name: monorepo, exact: true }),
    ).toBeVisible();
    await project.locator('.project-row').click({ button: 'right' });
    await menu.getByRole('menuitem', { name: '编辑', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '修改项目', exact: true });
    await expect(edit.locator('.project-path')).toHaveText(monorepo);
    await edit.getByRole('textbox', { name: '项目名称', exact: true }).fill('Vue Monorepo');
    await edit.getByRole('button', { name: '保存项目', exact: true }).click();
    await expect(project.locator('.project-label')).toHaveText('Vue Monorepo');
    await expect(other.locator('.project-location')).toHaveCount(0);
    await project.locator('.project-row').click({ button: 'right' });
    await menu.getByRole('menuitem', { name: '移除项目', exact: true }).click();
    await page
      .getByRole('dialog', { name: '移除项目？', exact: true })
      .getByRole('button', { name: '移除项目', exact: true })
      .click();
    await expect(project).toHaveCount(0);
    await expect(other).toBeVisible();
    expect(await page.evaluate(() => window.hikari!.agent.list())).toHaveLength(2);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});
