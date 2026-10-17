import { addWorkspaceProject } from './desktop-window';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { InteractiveSession, RemoteControlServer } from '../../packages/agent-host/src';
import type { ModelProvider } from '../../packages/agent-core/src';

test('remote browser controls the live host and shows its actual task result on mobile', async ({
  browser,
}) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-remote-ui-')));
  const provider: ModelProvider = {
    countTokens: () => 1,
    chat: async () => ({ text: 'Inspected the remote fixture task.', toolCalls: [] }),
    async *stream(request) {
      yield await this.chat(request);
    },
  };
  const session = new InteractiveSession({ root, provider });
  const server = new RemoteControlServer(session);
  const info = await server.listen(0);
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${info.port}`);
    await page.getByLabel('Access token').fill(info.token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('#project')).toHaveText(root);
    await page.getByLabel('New task').fill('Inspect the remote fixture task');
    await page.getByLabel('Mode', { exact: true }).selectOption('plan');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.locator('#events')).toContainText('Inspected the remote fixture task.');
    await expect(page.locator('#title')).toContainText('completed');
    await page.screenshot({ path: 'test-results/remote-mobile.png', fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop configures schedules, hooks, LSP and remote control through the new settings', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'hikari-platform-ui-'));
  const root = path.join(data, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'notes.md'), '# Fixture');
  const requireModule = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
  const app = await electron.launch({
    executablePath: requireModule('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, root);
    const page = await app.firstWindow();
    await addWorkspaceProject(page);
    await page.evaluate(async () => {
      await window.hikari!.agent.configure({
        provider: 'compatible',
        model: 'explicit-settings-fixture',
        apiKey: '',
        baseUrl: 'http://127.0.0.1:65534/v1',
      });
    });
    await page.getByRole('button', { name: 'Memory & extensions', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Memory & extensions' });
    await settings.getByRole('tab', { name: 'Automation and integrations', exact: true }).click();
    await settings.getByText('Scheduled tasks', { exact: true }).click();
    await settings.getByLabel('Task name', { exact: true }).fill('Hourly fixture');
    await settings
      .getByLabel('Task instructions')
      .fill('Inspect fixture changes; report only actionable changes.');
    await settings.getByRole('button', { name: 'Create schedule', exact: true }).click();
    await expect(settings.getByText('Hourly fixture', { exact: true })).toBeVisible();
    await settings.getByText('Lifecycle hooks', { exact: true }).click();
    const hooks = settings
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: 'Lifecycle hooks' }) });
    await hooks.getByLabel('Name', { exact: true }).fill('check-fixture');
    await hooks.getByLabel('Command', { exact: true }).fill('node');
    await hooks.getByLabel('Arguments, one per line').fill('--version');
    await hooks.getByRole('button', { name: 'Add hook' }).click();
    await expect(hooks.getByText('check-fixture', { exact: false })).toBeVisible();
    await settings.getByText('Language servers', { exact: true }).click();
    const lsp = settings
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: 'Language servers' }) });
    await lsp.getByLabel('Name', { exact: true }).fill('typescript');
    await lsp.getByLabel('Command', { exact: true }).fill('typescript-language-server');
    await lsp.getByLabel('Arguments, one per line').fill('--stdio');
    await lsp.getByRole('button', { name: 'Add language server' }).click();
    await expect(lsp.getByText('typescript · .ts .tsx', { exact: true })).toBeVisible();
    await settings.getByText('Remote control', { exact: true }).click();
    await settings.getByRole('button', { name: 'Start remote control', exact: true }).click();
    await expect(
      settings.getByRole('button', { name: 'Copy access token', exact: true }),
    ).toBeVisible();
    await settings.getByRole('button', { name: 'Stop remote control', exact: true }).click();
    const values = await page.evaluate(async () => window.hikari!.platform.list());
    expect(values.automations).toHaveLength(1);
    expect(values.hooks).toHaveLength(1);
    expect(values.lsp).toHaveLength(1);
    expect(values.remote).toBeUndefined();
    await page.screenshot({ path: 'test-results/platform-settings.png', fullPage: true });
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});
