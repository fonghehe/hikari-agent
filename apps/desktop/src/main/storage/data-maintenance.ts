import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { chmod, link, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { collections } from '@hikari/database';
import type { LocalPersistence } from './persistence';

export const storageSchemaVersion = 1;
const pendingName = 'restore.pending.sqlite';

export function validateDatabase(filename: string): void {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
      throw new Error('Backup integrity check failed');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > storageSchemaVersion) throw new Error('Backup requires a newer Hikari version');
    for (const table of collections) {
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
      if (
        !['id', 'owner', 'version', 'data', 'updated_at'].every((column) =>
          columns.includes(column),
        )
      )
        throw new Error('Not a compatible Hikari database');
      if (db.prepare(`SELECT id FROM ${table} WHERE NOT json_valid(data) LIMIT 1`).get())
        throw new Error('Backup contains invalid records');
    }
  } finally {
    db.close();
  }
}

async function snapshot(db: DatabaseSync, destination: string): Promise<void> {
  let reserved = false;
  try {
    await writeFile(destination, '', { flag: 'wx', mode: 0o600 });
    reserved = true;
    await backup(db, destination);
    await chmod(destination, 0o600);
    validateDatabase(destination);
  } catch (error) {
    if (reserved) await rm(destination, { force: true });
    throw error;
  }
}

export async function backupData(
  persistence: LocalPersistence,
  destination: string,
): Promise<void> {
  persistence.flush();
  await snapshot(persistence.repository.db, destination);
}

export async function stageRestore(persistence: LocalPersistence, source: string): Promise<void> {
  validateDatabase(source);
  const directory = path.dirname(persistence.repository.filename);
  const temporary = path.join(directory, `.restore-${randomUUID()}.sqlite`);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await snapshot(db, temporary);
    // Do not replace an earlier pending restore or the currently running database.
    await link(temporary, path.join(directory, pendingName));
  } finally {
    db.close();
    await rm(temporary, { force: true });
  }
}

/** Runs only after the single-instance lock and before opening the application repository. */
export async function applyPendingRestore(database: string): Promise<boolean> {
  const directory = path.dirname(database),
    pending = path.join(directory, pendingName);
  if (!existsSync(pending)) return false;
  validateDatabase(pending);
  if (existsSync(database)) {
    const current = new DatabaseSync(database);
    try {
      await snapshot(
        current,
        path.join(directory, `before-restore-${Date.now()}-${randomUUID()}.sqlite`),
      );
      const checkpoint = current.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (Number(checkpoint?.busy ?? 0) !== 0)
        throw new Error('Close other database clients before restoring');
    } finally {
      current.close();
    }
    await rm(database + '-wal', { force: true });
    await rm(database + '-shm', { force: true });
  }
  await rename(pending, database);
  return true;
}

export async function storageStatus(persistence: LocalPersistence) {
  persistence.flush();
  const db = persistence.repository.db;
  const tables = Object.fromEntries(
    collections.map((table) => [
      table,
      Number(
        db.prepare(`SELECT count(*) AS count FROM ${table} WHERE owner='local'`).get()?.count ?? 0,
      ),
    ]),
  );
  const filename = persistence.repository.filename;
  let bytes = 0;
  for (const suffix of ['', '-wal', '-shm'])
    bytes += (await stat(filename + suffix).catch(() => undefined))?.size ?? 0;
  return {
    schemaVersion: Number(db.prepare('PRAGMA user_version').get()?.user_version),
    bytes,
    tables,
    pendingRestore: existsSync(path.join(path.dirname(filename), pendingName)),
  };
}
