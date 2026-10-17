import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalPersistence } from '../../apps/desktop/src/main/persistence';
import { TaskManager } from '../../packages/agent-runtime/src';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

test('project chat settings retain their own root and field surfaces while sync opens as a dialog', async () => {
  const data = await realpath(
    await mkdtemp(path.join(tmpdir(), 'hikari-project-settings-context-')),
  );
  const alpha = path.join(data, 'alpha'),
    beta = path.join(data, 'beta');
  for (const root of [alpha, beta]) {
    await mkdir(path.join(root, '.agent'), { recursive: true });
    await writeFile(
      path.join(root, '.agent', 'mcp.json'),
      JSON.stringify({
        [path.basename(root)]: { transport: 'http', url: 'https://example.invalid/mcp' },
      }),
    );
  }
  const persistence = new LocalPersistence(path.join(data, 'hakari.sqlite'));
  const manager = new TaskManager();
  for (const root of [alpha, beta]) {
    const task = manager.create(`${path.basename(root)} conversation`, root);
    task.status = 'completed';
    persistence.task(task);
    persistence.memories.put(root, {
      id: randomUUID(),
      title: `${path.basename(root)} memory`,
      content: `Only ${path.basename(root)} facts`,
      updatedAt: new Date().toISOString(),
    });
  }
  const chat = manager.create('General chat', 'chat://general');
  chat.chat = true;
  chat.status = 'completed';
  persistence.task(chat);
  await persistence.close();
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async (root) => {
      await window.hikari!.workspace.select(root);
      await window.hikari!.preferences.set({ theme: 'light', language: 'en' });
    }, beta);
    await page.reload();
    const nav = page.getByRole('navigation', { name: 'Conversations and projects' });
    const alphaGroup = nav.getByRole('region', { name: alpha, exact: true });
    const projectEntry = page.locator('main .conversation-project-settings');
    await expect(nav.getByRole('button', { name: 'Memory & extensions', exact: true })).toHaveCount(
      0,
    );
    await expect(projectEntry).toHaveAttribute('title', beta);
    await nav.locator('.task-button').filter({ hasText: 'General chat' }).click();
    await expect(projectEntry).toHaveCount(0);
    await alphaGroup.locator('.task-button').filter({ hasText: 'alpha conversation' }).click();
    await expect(projectEntry).toHaveText('Memory & extensions');
    await expect(projectEntry).toHaveAttribute('title', alpha);
    expect(
      await projectEntry.evaluate((entry) => {
        const composer = document.querySelector('.follow-up-composer .composer')!;
        return entry.getBoundingClientRect().top >= composer.getBoundingClientRect().bottom;
      }),
    ).toBe(true);
    await page.screenshot({ path: 'test-results/conversation-project-settings.png' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(
      page
        .locator('.sidebar-settings')
        .getByRole('button', { name: 'Memory & extensions', exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await projectEntry.click();
    const settings = page.getByRole('dialog', { name: 'Memory & extensions', exact: true });
    await expect(settings.locator('.project-settings-context')).toContainText(alpha);
    await expect(settings.getByText('alpha memory', { exact: true })).toBeVisible();
    await expect(settings.getByText('beta memory', { exact: true })).toHaveCount(0);
    await settings.getByRole('tab', { name: 'Extensions', exact: true }).click();
    await expect(settings.getByText('alpha', { exact: true }).last()).toBeVisible();
    await expect(settings.getByText('beta', { exact: true })).toHaveCount(0);
    await settings.getByLabel('Server name', { exact: true }).fill('saved-in-alpha');
    await settings.getByLabel('Server URL', { exact: true }).fill('https://example.invalid/saved');
    await settings.getByRole('button', { name: 'Save server', exact: true }).click();
    await expect(settings.getByText('saved-in-alpha', { exact: true })).toBeVisible();
    expect(await readFile(path.join(alpha, '.agent', 'mcp.json'), 'utf8')).toContain(
      'saved-in-alpha',
    );
    expect(await readFile(path.join(beta, '.agent', 'mcp.json'), 'utf8')).not.toContain(
      'saved-in-alpha',
    );
    await settings.getByRole('tab', { name: 'Automation and integrations', exact: true }).click();
    await settings.getByText('Lifecycle hooks', { exact: true }).click();
    const hooks = settings
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: 'Lifecycle hooks' }) });
    await hooks.getByLabel('Name', { exact: true }).fill('alpha-hook');
    await hooks.getByLabel('Command', { exact: true }).fill('node');
    await hooks.getByRole('button', { name: 'Add hook', exact: true }).click();
    await expect(hooks.getByText(/alpha-hook/)).toBeVisible();
    expect(await readFile(path.join(alpha, '.agent', 'hooks.json'), 'utf8')).toContain(
      'alpha-hook',
    );
    expect(
      (await page.evaluate((root) => window.hikari!.platform.list(root), beta)).hooks,
    ).toHaveLength(0);
    expect((await page.evaluate(() => window.hikari!.workspace.snapshot()))?.root).toBe(beta);
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(
        (theme) => window.hikari!.preferences.set({ theme, language: 'en' }),
        theme,
      );
      await page.reload();
      await alphaGroup.locator('.task-button').filter({ hasText: 'alpha conversation' }).click();
      await projectEntry.click();
      await settings.getByRole('tab', { name: 'Extensions', exact: true }).click();
      await settings.getByLabel('Transport', { exact: true }).selectOption('stdio');
      const textarea = settings.getByLabel('Arguments (one per line)', { exact: true });
      await textarea.focus();
      const surface = await textarea.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          border: style.borderStyle,
          radius: parseFloat(style.borderRadius),
          panel: getComputedStyle(element.closest('dialog')!).backgroundColor,
        };
      });
      expect(surface.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(surface.background).not.toBe(surface.panel);
      expect(surface.border).toBe('solid');
      expect(surface.radius).toBeGreaterThanOrEqual(6);
      await page.screenshot({ path: `test-results/project-field-surface-${theme}.png` });
      await settings.getByRole('button', { name: 'Close', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Account & sync', exact: true }).click();
    const sync = page.getByRole('dialog', { name: 'Account & sync', exact: true });
    await expect(sync.getByLabel('Sync email', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Toggle right panel', exact: true }),
    ).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('complementary', { name: 'Right panel' })).toBeHidden();
    await page.screenshot({ path: 'test-results/account-sync-dialog.png' });
    await page.keyboard.press('Escape');
    await expect(sync).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
    await expect(
      page.evaluate((root) => window.hikari!.extensions.list(root), data),
    ).rejects.toThrow('Project is not registered');
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});
