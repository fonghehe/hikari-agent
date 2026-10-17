import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { desktopDataPath, migrateDesktopDatabase } from '../apps/desktop/src/main/data-path';

describe('Hikari data compatibility', () => {
  it('uses hakari.sqlite and discovers legacy data without changing it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hikari-data-path-'));
    const oldDevelopment = path.join(root, '@forge/desktop');
    const oldApplication = path.join(root, 'Forge');
    const current = path.join(root, 'Hikari');
    const override = path.join(root, 'explicit');
    try {
      expect(desktopDataPath(root, oldDevelopment)).toEqual({
        directory: current,
        database: path.join(current, 'hakari.sqlite'),
      });
      await mkdir(oldDevelopment, { recursive: true });
      await writeFile(path.join(oldDevelopment, 'forge.sqlite'), 'old-data');
      expect(desktopDataPath(root, oldDevelopment).legacyDatabase).toBe(
        path.join(oldDevelopment, 'forge.sqlite'),
      );
      await mkdir(oldApplication);
      await writeFile(path.join(oldApplication, 'forge.sqlite'), 'old-packaged-data');
      expect(desktopDataPath(root, path.join(root, 'unused')).legacyDatabase).toBe(
        path.join(oldApplication, 'forge.sqlite'),
      );
      await mkdir(current);
      await writeFile(path.join(current, 'hikari.sqlite'), 'current-data');
      expect(desktopDataPath(root, oldDevelopment).directory).toBe(current);
      expect(desktopDataPath(root, oldDevelopment).legacyDatabase).toBe(
        path.join(current, 'hikari.sqlite'),
      );
      expect(desktopDataPath(root, oldDevelopment, override).directory).toBe(override);
      expect(desktopDataPath(root, oldDevelopment, override).legacyDatabase).toBeUndefined();
      await mkdir(override);
      await writeFile(path.join(override, 'forge.sqlite'), 'explicit-legacy-data');
      expect(desktopDataPath(root, oldDevelopment, override).legacyDatabase).toBe(
        path.join(override, 'forge.sqlite'),
      );
      await writeFile(path.join(current, 'hakari.sqlite'), 'new-data');
      expect(desktopDataPath(root, oldDevelopment)).toEqual({
        directory: current,
        database: path.join(current, 'hakari.sqlite'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('migrates committed WAL records, preserves the original and does not overwrite current data', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hikari-migrate-wal-'));
    const legacy = path.join(root, '@forge', 'desktop');
    await mkdir(legacy, { recursive: true });
    const filename = path.join(legacy, 'forge.sqlite');
    const source = new DatabaseSync(filename);
    source.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records (id TEXT PRIMARY KEY, data TEXT); INSERT INTO records VALUES ('task', 'history'), ('config', 'encrypted-fixture'), ('memory', 'project-fact');",
    );
    try {
      const target = desktopDataPath(root, legacy);
      await migrateDesktopDatabase(target);
      expect(existsSync(filename)).toBe(true);
      const migrated = new DatabaseSync(target.database);
      try {
        expect(migrated.prepare('SELECT * FROM records ORDER BY id').all()).toEqual(
          source.prepare('SELECT * FROM records ORDER BY id').all(),
        );
        migrated.exec("INSERT INTO records VALUES ('new-task', 'new-history')");
      } finally {
        migrated.close();
      }
      await migrateDesktopDatabase(target);
      const reopened = new DatabaseSync(target.database, { readOnly: true });
      try {
        expect(reopened.prepare('SELECT count(*) AS total FROM records').get()?.total).toBe(4);
        expect(reopened.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');
        expect(source.prepare('SELECT count(*) AS total FROM records').get()?.total).toBe(3);
      } finally {
        reopened.close();
      }
    } finally {
      source.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves corrupt legacy data intact and never publishes a partial migration', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hikari-migrate-invalid-'));
    try {
      const legacy = path.join(root, 'forge.sqlite');
      await writeFile(legacy, 'invalid database');
      const target = desktopDataPath(root, root, root);
      await expect(migrateDesktopDatabase(target)).rejects.toThrow();
      expect(existsSync(legacy)).toBe(true);
      expect(existsSync(target.database)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
