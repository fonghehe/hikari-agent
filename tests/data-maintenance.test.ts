import { expect, it } from 'vitest';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LocalPersistence } from '../apps/desktop/src/main/persistence';
import {
  backupData,
  stageRestore,
  applyPendingRestore,
  storageStatus,
  validateDatabase,
} from '../apps/desktop/src/main/data-maintenance';

it('backs up live WAL data, defers restore and retains a recoverable copy of current data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-maintenance-'));
  const filename = path.join(root, 'hakari.sqlite'),
    copy = path.join(root, 'backup.sqlite');
  let persistence = new LocalPersistence(filename);
  try {
    persistence.save('messages', 'fact', 'original');
    await backupData(persistence, copy);
    await expect(backupData(persistence, copy)).rejects.toThrow();
    persistence.save('messages', 'fact', 'new work');
    await stageRestore(persistence, copy);
    expect(persistence.get('messages', 'fact')?.data).toBe('new work');
    expect((await storageStatus(persistence)).pendingRestore).toBe(true);
    await expect(stageRestore(persistence, copy)).rejects.toThrow();
    await persistence.close();
    expect(await applyPendingRestore(filename)).toBe(true);
    persistence = new LocalPersistence(filename);
    expect(persistence.get('messages', 'fact')?.data).toBe('original');
    const safety = (await readdir(root)).find((name) => name.startsWith('before-restore-'))!;
    const recovered = new DatabaseSync(path.join(root, safety), { readOnly: true });
    try {
      expect(recovered.prepare("SELECT data FROM messages WHERE id='fact'").get()?.data).toBe(
        '"new work"',
      );
    } finally {
      recovered.close();
    }
    expect(await applyPendingRestore(filename)).toBe(false);
  } finally {
    await persistence.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects corrupt, unrelated and future-schema backups without altering the current database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-backup-invalid-'));
  const current = new LocalPersistence(path.join(root, 'hakari.sqlite'));
  try {
    current.save('messages', 'fact', 'keep');
    const corrupt = path.join(root, 'corrupt.sqlite');
    await writeFile(corrupt, 'not sqlite');
    expect(() => validateDatabase(corrupt)).toThrow();
    const unrelated = path.join(root, 'unrelated.sqlite'),
      db = new DatabaseSync(unrelated);
    db.exec('CREATE TABLE unrelated(id TEXT)');
    db.close();
    await expect(stageRestore(current, unrelated)).rejects.toThrow('compatible');
    const future = path.join(root, 'future.sqlite');
    await backupData(current, future);
    const newer = new DatabaseSync(future);
    newer.exec('PRAGMA user_version=99');
    newer.close();
    await expect(stageRestore(current, future)).rejects.toThrow('newer');
    expect(current.get('messages', 'fact')?.data).toBe('keep');
    expect((await storageStatus(current)).pendingRestore).toBe(false);
  } finally {
    await current.close();
    await rm(root, { recursive: true, force: true });
  }
});
