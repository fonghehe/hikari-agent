import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text, integer, jsonb, primaryKey } from 'drizzle-orm/pg-core';
import { and, eq, sql, desc, asc } from 'drizzle-orm';
import {
  collections,
  listBounds,
  type ListOptions,
  ConflictError,
  type Collection,
  type RecordEntry,
  type Repository,
} from './index';
function documentTable(name: string) {
  return pgTable(
    name,
    {
      id: text('id').notNull(),
      owner: text('owner').notNull(),
      version: integer('version').notNull(),
      data: jsonb('data').notNull(),
      updatedAt: text('updated_at').notNull(),
    },
    (table) => [primaryKey({ columns: [table.owner, table.id] })],
  );
}
export const schema = Object.fromEntries(
  collections.map((name) => [name, documentTable(name)]),
) as Record<Collection, ReturnType<typeof documentTable>>;
export class PostgresRepository implements Repository {
  private pool: Pool;
  private db: ReturnType<typeof drizzle>;
  constructor(url: string) {
    this.pool = new Pool({ connectionString: url, max: 10 });
    this.db = drizzle(this.pool);
  }
  async migrate() {
    for (const name of collections)
      await this.db.execute(
        sql.raw(
          `CREATE TABLE IF NOT EXISTS ${name} (id TEXT NOT NULL, owner TEXT NOT NULL, version INTEGER NOT NULL, data JSONB NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner,id))`,
        ),
      );
  }
  async get(collection: Collection, owner: string, id: string) {
    const table = schema[collection];
    const rows = await this.db
      .select()
      .from(table)
      .where(and(eq(table.owner, owner), eq(table.id, id)))
      .limit(1);
    return rows[0] as RecordEntry | undefined;
  }
  async list(collection: Collection, owner: string, options?: ListOptions) {
    const { limit, offset } = listBounds(options);
    const table = schema[collection];
    return (await this.db
      .select()
      .from(table)
      .where(eq(table.owner, owner))
      .orderBy(desc(table.updatedAt), asc(table.id))
      .limit(limit)
      .offset(offset)) as RecordEntry[];
  }
  async put(
    collection: Collection,
    owner: string,
    id: string,
    data: unknown,
    expectedVersion: number,
  ) {
    const table = schema[collection];
    const updatedAt = new Date().toISOString();
    if (expectedVersion === 0) {
      try {
        const rows = await this.db
          .insert(table)
          .values({ id, owner, version: 1, data, updatedAt })
          .onConflictDoNothing()
          .returning();
        if (!rows[0]) throw new ConflictError();
        return rows[0] as RecordEntry;
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new ConflictError();
        throw error;
      }
    }
    const rows = await this.db
      .update(table)
      .set({ data, version: expectedVersion + 1, updatedAt })
      .where(and(eq(table.id, id), eq(table.owner, owner), eq(table.version, expectedVersion)))
      .returning();
    if (!rows[0]) throw new ConflictError();
    return rows[0] as RecordEntry;
  }
  async remove(collection: Collection, owner: string, id: string) {
    const table = schema[collection];
    await this.db.delete(table).where(and(eq(table.id, id), eq(table.owner, owner)));
  }
  async close() {
    await this.pool.end();
  }
}
