import { app, dialog, safeStorage } from 'electron';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { secureStorageAvailable } from '../secret-storage';
import { backupData, stageRestore, storageStatus } from '../data-maintenance';
import { removeSavedTask } from './tasks';
import type { DesktopContext, RegisterHandler } from './context';

export function registerMaintenanceHandlers(handle: RegisterHandler, context: DesktopContext) {
  const { host, persistence } = context;
  let busy = false;
  const idle = () => {
    if (
      host.runners.size ||
      host.scheduler.queuedCount ||
      host.tasks
        .list()
        .some((task) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status))
    )
      throw new Error('Finish all active tasks before data maintenance');
  };
  const exclusive = async (work: () => Promise<boolean>) => {
    if (busy) throw new Error('Data maintenance is already running');
    busy = true;
    host.maintenance = true;
    try {
      return await work();
    } finally {
      busy = false;
      host.maintenance = (await storageStatus(persistence)).pendingRestore;
    }
  };
  handle('maintenance:status', async () => ({
    ...(await storageStatus(persistence)),
    secureCredentials: secureStorageAvailable(safeStorage),
  }));
  handle('maintenance:cancelRestore', async () => {
    await exclusive(async () => {
      await rm(path.join(path.dirname(persistence.repository.filename), 'restore.pending.sqlite'), {
        force: true,
      });
      return true;
    });
  });
  handle('maintenance:backup', () =>
    exclusive(async () => {
      idle();
      const result = await dialog.showSaveDialog(context.window, {
        defaultPath: `hikari-backup-${Date.now()}.sqlite`,
        filters: [{ name: 'Hikari backup', extensions: ['sqlite'] }],
      });
      if (result.canceled || !result.filePath) return false;
      idle();
      await backupData(persistence, result.filePath);
      return true;
    }),
  );
  handle('maintenance:restore', () =>
    exclusive(async () => {
      idle();
      const selected = await dialog.showOpenDialog(context.window, {
        properties: ['openFile'],
        filters: [{ name: 'Hikari backup', extensions: ['sqlite'] }],
      });
      if (selected.canceled || !selected.filePaths[0]) return false;
      const answer = await dialog.showMessageBox(context.window, {
        type: 'warning',
        message: 'Restore this Hikari backup on next startup?',
        detail:
          'Current data will be backed up before replacement. Backups contain private task data. Model credentials may require reconnecting. Project files are not restored.',
        buttons: ['Cancel', 'Restore on next startup'],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) return false;
      idle();
      await stageRestore(persistence, selected.filePaths[0]);
      return true;
    }),
  );
  handle('maintenance:prune', () =>
    exclusive(async () => {
      idle();
      const cutoff = Date.now() - 30 * 86400000;
      const candidates = host.tasks
        .list()
        .filter(
          (task) =>
            task.archived &&
            !task.worktree &&
            ['completed', 'failed', 'cancelled'].includes(task.status) &&
            Date.parse(task.updatedAt) < cutoff,
        );
      if (!candidates.length) return false;
      const answer = await dialog.showMessageBox(context.window, {
        type: 'warning',
        message: `Delete ${candidates.length} archived tasks older than 30 days?`,
        detail:
          'A full private database backup will be created first. Task events and unused attachments will be removed; project files and shared project memory remain.',
        buttons: ['Cancel', 'Back up and delete'],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) return false;
      idle();
      await backupData(
        persistence,
        path.join(
          path.dirname(persistence.repository.filename),
          `before-cleanup-${Date.now()}.sqlite`,
        ),
      );
      for (const task of candidates) await removeSavedTask(context, task.id);
      return true;
    }),
  );
  handle('maintenance:diagnostics', async () => {
    const result = await dialog.showSaveDialog(context.window, {
      defaultPath: 'hikari-diagnostics.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return false;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      result.filePath,
      JSON.stringify(
        {
          format: 'hikari-diagnostics',
          version: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          uptimeSeconds: Math.round(process.uptime()),
          memory: process.memoryUsage(),
          activeTasks: host.runners.size,
          queuedTasks: host.scheduler.queuedCount,
          storage: await storageStatus(persistence),
          secureCredentials: secureStorageAvailable(safeStorage),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return true;
  });
}
