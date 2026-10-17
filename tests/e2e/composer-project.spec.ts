import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalPersistence } from '../../apps/desktop/src/main/persistence';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

test('composer selects, searches and clears projects without losing the draft or deleting projects', async () => {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-composer-project-')));
  const first = path.join(data, 'work', 'website');
  const second = path.join(data, 'personal', 'website');
  const added = path.join(data, 'new-project');
  for (const root of [first, second, added]) await mkdir(root, { recursive: true });
  const store = new LocalPersistence(path.join(data, 'hakari.sqlite'));
  for (const root of [first, second]) store.save('workspaces', root, { root, name: 'website' });
  store.save('workspaces', 'hidden', {
    root: path.join(data, 'hidden'),
    name: 'Hidden',
    hidden: true,
  });
  await store.close();
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'Project context received.' } }] }));
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
    await page.evaluate(async (baseUrl) => {
      await window.hikari!.preferences.set({ theme: 'light', language: 'en' });
      await window.hikari!.agent.configure({
        provider: 'compatible',
        model: 'fixture',
        baseUrl,
        apiKey: '',
      });
    }, `http://127.0.0.1:${address.port}/v1`);
    await page.reload();
    const prompt = page.getByRole('textbox', { name: 'Task prompt', exact: true });
    await prompt.fill('Keep this draft');
    const trigger = page.getByRole('button', { name: 'Select project', exact: true });
    await trigger.click();
    const picker = page.getByRole('dialog', { name: 'Select project', exact: true });
    const search = picker.getByRole('textbox', { name: 'Search projects', exact: true });
    await expect(search).toBeFocused();
    await expect(picker.getByRole('button', { name: /website/ })).toHaveCount(2);
    await expect(picker).not.toContainText('Hidden');
    await search.fill('no-matching-project');
    await expect(picker).toContainText('No projects found');
    await search.fill('personal');
    await expect(picker.getByRole('button', { name: /website/ })).toHaveCount(1);
    await search.press('ArrowDown');
    await expect(
      picker.getByRole('button', { name: 'website · personal', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(picker).not.toBeVisible();
    await expect(prompt).toHaveValue('Keep this draft');
    await expect(page.locator('.composer-project')).toContainText('website');
    expect((await page.evaluate(() => window.hikari!.workspace.snapshot()))?.root).toBe(second);
    await page.getByRole('button', { name: 'Change project', exact: true }).click();
    await expect(search).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(picker).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Change project', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Change project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search tasks', exact: true }).click();
    await expect(picker).not.toBeVisible();
    await page.getByRole('button', { name: 'Clear project selection', exact: true }).click();
    await expect(trigger).toBeVisible();
    await expect(prompt).toHaveValue('Keep this draft');
    expect(await page.evaluate(() => window.hikari!.workspace.snapshot())).toBeNull();
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect
      .poll(() => page.evaluate(async () => (await window.hikari!.agent.list())[0]?.status))
      .toBe('completed');
    expect((await page.evaluate(() => window.hikari!.agent.list()))[0]?.chat).toBe(true);
    await page.keyboard.press('ControlOrMeta+n');
    await prompt.fill('Use the chosen project');
    await trigger.click();
    await picker.getByRole('button', { name: 'website · work', exact: true }).click();
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.hikari!.agent.list()).find(
              (task) => task.prompt === 'Use the chosen project',
            )?.status,
        ),
      )
      .toBe('completed');
    const task = (await page.evaluate(() => window.hikari!.agent.list())).find(
      (task) => task.prompt === 'Use the chosen project',
    );
    expect(task?.workspace).toBe(first);
    expect(task?.chat).toBeFalsy();
    await page.keyboard.press('ControlOrMeta+n');
    await prompt.fill('Draft survives project creation');
    await page.getByRole('button', { name: 'Change project', exact: true }).click();
    await picker.getByRole('button', { name: 'New project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create project', exact: true });
    await dialog.getByLabel('Source options', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Enter a path', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'File or folder path', exact: true }).fill(added);
    await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(prompt).toHaveValue('Draft survives project creation');
    await expect(page.locator('.composer-project')).toContainText('new-project');
    await page.getByRole('button', { name: 'Clear project selection', exact: true }).click();
    await page.reload();
    await expect(trigger).toBeVisible();
    const projects = await page.evaluate(() => window.hikari!.workspace.recent());
    expect(
      projects
        .filter((project) => !project.hidden)
        .map((project) => project.root)
        .sort(),
    ).toEqual([first, second, added].sort());
    await page.setViewportSize({ width: 1000, height: 700 });
    await trigger.click();
    await expect(picker).toBeVisible();
    const bounds = await picker.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1000);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700);
    await page.keyboard.press('Escape');
    await expect(picker).not.toBeVisible();
    await page.evaluate(() =>
      window.hikari!.preferences.set({ theme: 'light', language: 'zh-CN' }),
    );
    await page.reload();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: '选择项目', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '搜索项目', exact: true })).toBeFocused();
    await page.screenshot({ path: test.info().outputPath('composer-project-picker.png') });
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
