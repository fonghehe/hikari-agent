import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
export const collections = [
  'users',
  'workspaces',
  'tasks',
  'conversations',
  'messages',
  'agents',
  'tool_calls',
  'skills',
  'model_configs',
  'sessions',
  'events',
  'changes',
  'grants',
] as const;
export type Collection = (typeof collections)[number];
export interface RecordEntry {
  id: string;
  owner: string;
  version: number;
  data: unknown;
  updatedAt: string;
}
export class ConflictError extends Error {
  constructor() {
    super('Record changed. Pull the latest version before saving.');
  }
}
export interface ListOptions {
  limit?: number;
  offset?: number;
}
export function listBounds(options: ListOptions = {}) {
  const limit = options.limit ?? 500,
    offset = options.offset ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 5000 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new Error('Invalid pagination');
  return { limit, offset };
}
export interface Repository {
  get(collection: Collection, owner: string, id: string): Promise<RecordEntry | undefined>;
  list(collection: Collection, owner: string, options?: ListOptions): Promise<RecordEntry[]>;
  put(
    collection: Collection,
    owner: string,
    id: string,
    data: unknown,
    expectedVersion: number,
  ): Promise<RecordEntry>;
  remove(collection: Collection, owner: string, id: string): Promise<void>;
  close(): Promise<void>;
}
export class SQLiteRepository implements Repository {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    for (const table of collections)
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (id TEXT NOT NULL, owner TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner,id))`,
      );
  }
  private table(collection: Collection) {
    if (!collections.includes(collection)) throw new Error('Invalid collection');
    return collection;
  }
  private decode(row: Record<string, unknown> | undefined): RecordEntry | undefined {
    return row
      ? {
          id: String(row.id),
          owner: String(row.owner),
          version: Number(row.version),
          data: JSON.parse(String(row.data)) as unknown,
          updatedAt: String(row.updated_at),
        }
      : undefined;
  }
  getSync(collection: Collection, owner: string, id: string) {
    return this.decode(
      this.db
        .prepare(`SELECT * FROM ${this.table(collection)} WHERE owner=? AND id=?`)
        .get(owner, id),
    );
  }
  listSync(collection: Collection, owner: string, options?: ListOptions) {
    const { limit, offset } = listBounds(options);
    return this.db
      .prepare(
        `SELECT * FROM ${this.table(collection)} WHERE owner=? ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(owner, limit, offset)
      .map((row) => this.decode(row)!);
  }
  putSync(
    collection: Collection,
    owner: string,
    id: string,
    data: unknown,
    expectedVersion: number,
  ) {
    const updatedAt = new Date().toISOString();
    const encoded = JSON.stringify(data);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getSync(collection, owner, id);
      if ((existing?.version ?? 0) !== expectedVersion) throw new ConflictError();
      this.db
        .prepare(
          `INSERT INTO ${this.table(collection)} (id,owner,version,data,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET version=excluded.version,data=excluded.data,updated_at=excluded.updated_at`,
        )
        .run(id, owner, expectedVersion + 1, encoded, updatedAt);
      this.db.exec('COMMIT');
      return { id, owner, version: expectedVersion + 1, data, updatedAt };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async get(collection: Collection, owner: string, id: string) {
    return this.getSync(collection, owner, id);
  }
  async list(collection: Collection, owner: string, options?: ListOptions) {
    return this.listSync(collection, owner, options);
  }
  async put(
    collection: Collection,
    owner: string,
    id: string,
    data: unknown,
    expectedVersion: number,
  ) {
    return this.putSync(collection, owner, id, data, expectedVersion);
  }
  async remove(collection: Collection, owner: string, id: string) {
    this.db.prepare(`DELETE FROM ${this.table(collection)} WHERE owner=? AND id=?`).run(owner, id);
  }
  async close() {
    this.db.close();
  }
}
