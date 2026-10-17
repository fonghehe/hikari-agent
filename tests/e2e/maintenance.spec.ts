import type { BaseWindow, SaveDialogOptions } from 'electron';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { LocalPersistence } from '../../apps/desktop/src/main/persistence';
import { TaskManager } from '../../packages/agent-runtime/src';

test('data settings back up, export private-free diagnostics, stage/cancel restore and prune archived tasks', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'hikari-maintenance-ui-'));
  const backup = path.join(data, 'backup.sqlite'),
    diagnostic = path.join(data, 'diagnostic.json');
  const persistence = new LocalPersistence(path.join(data, 'hakari.sqlite'));
  const task = new TaskManager().create('private prompt must not appear in diagnostics', '');
  task.status = 'completed';
  task.archived = true;
  task.demo = true;
  task.updatedAt = new Date(Date.now() - 40 * 86400000).toISOString();
  persistence.task(task);
  await persistence.close();
  const requireModule = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
  const app = await electron.launch({
    executablePath: requireModule('electron'),
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    await app.evaluate(
      ({ dialog }, { backup, diagnostic }) => {
        dialog.showSaveDialog = async (
          windowOrOptions: BaseWindow | SaveDialogOptions,
          options?: SaveDialogOptions,
        ) => ({
          canceled: false,
          filePath: String(
            options?.defaultPath ??
              ('defaultPath' in windowOrOptions ? windowOrOptions.defaultPath : ''),
          ).endsWith('.json')
            ? diagnostic
            : backup,
        });
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [backup] });
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      },
      { backup, diagnostic },
    );
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Data & updates', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Data & updates' });
    await settings.getByRole('tab', { name: 'Data and diagnostics', exact: true }).click();
    await settings.getByRole('button', { name: 'Create data backup', exact: true }).click();
    await expect.poll(() => existsSync(backup)).toBe(true);
    await expect(settings.getByRole('button', { name: 'Export diagnostics' })).toBeEnabled();
    await settings.getByRole('button', { name: 'Export diagnostics' }).click();
    await expect.poll(() => existsSync(diagnostic)).toBe(true);
    const exported = await readFile(diagnostic, 'utf8');
    expect(exported).not.toContain(task.prompt);
    expect(exported).not.toContain(data);
    expect(JSON.parse(exported).storage.schemaVersion).toBe(1);
    await settings.getByRole('button', { name: 'Restore data backup', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('Restore pending');
    await expect(
      page.evaluate(() => window.hikari!.agent.start('new task while restore pending')),
    ).rejects.toThrow('maintenance');
    await settings.getByRole('button', { name: 'Cancel pending restore' }).click();
    await expect(settings.getByRole('status')).toHaveCount(0);
    await settings.getByRole('button', { name: 'Clean archived tasks older than 30 days' }).click();
    await expect
      .poll(() => page.evaluate(() => window.hikari!.agent.list().then((tasks) => tasks.length)))
      .toBe(0);
    expect((await readdir(data)).some((file) => file.startsWith('before-cleanup-'))).toBe(true);
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});
