import { chmodSync, existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export interface DesktopDataPath {
  directory: string;
  database: string;
  legacyDatabase?: string;
}

export function desktopDataPath(
  appData: string,
  previousUserData: string,
  override?: string,
): DesktopDataPath {
  const directory = override ? path.resolve(override) : path.join(appData, 'Hikari');
  const database = path.join(directory, 'hakari.sqlite');
  if (existsSync(database)) return { directory, database };
  const candidates = override
    ? [directory]
    : [
        directory,
        previousUserData,
        path.join(appData, 'Forge'),
        path.join(appData, '@forge', 'desktop'),
      ];
  const legacyDatabase = [...new Set(candidates)]
    .flatMap((candidate) =>
      ['hakari.sqlite', 'hikari.sqlite', 'forge.sqlite'].map((name) => path.join(candidate, name)),
    )
    .find((filename) => existsSync(filename));
  return { directory, database, ...(legacyDatabase ? { legacyDatabase } : {}) };
}

/** SQLite backup includes committed WAL data; keep the original as a recovery copy. */
export async function migrateDesktopDatabase(target: DesktopDataPath) {
  mkdirSync(target.directory, { recursive: true, mode: 0o700 });
  if (!target.legacyDatabase || existsSync(target.database)) return;
  const temporary = path.join(target.directory, `.database-migration-${randomUUID()}.sqlite`);
  const source = new DatabaseSync(target.legacyDatabase, { readOnly: true });
  try {
    writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 });
    await backup(source, temporary);
    chmodSync(temporary, 0o600);
    const copy = new DatabaseSync(temporary, { readOnly: true });
    try {
      if (copy.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        throw new Error('Database migration integrity check failed');
    } finally {
      copy.close();
    }
    // Publish a complete snapshot atomically, never replacing an existing database.
    linkSync(temporary, target.database);
  } finally {
    source.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(temporary + suffix, { force: true });
  }
}
