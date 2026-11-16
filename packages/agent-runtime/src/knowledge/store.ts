import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { searchTerms, redactText } from '@hikari/agent-core';
import { cosine, validateVector } from './vectors';

export interface IndexedDocument {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
}
export interface IndexStatus {
  state: 'building' | 'ready' | 'failed';
  generation: number;
  requestedVersion: string;
  activeVersion?: string;
  chunks: number;
  error?: string;
  updatedAt: string;
  sourceRevision?: number;
}
export interface RankedDocument extends IndexedDocument {
  score: number;
}
/** Exact search is a backend choice, not part of the model-facing tool contract. */
export interface KnowledgeStore {
  status(scope: string): IndexStatus | undefined;
  begin(scope: string, version: string): number;
  cached(scope: string, identity: string, texts: string[]): (number[] | undefined)[];
  publish(
    scope: string,
    generation: number,
    version: string,
    documents: IndexedDocument[],
    identity: string,
    vectors: number[][],
  ): void;
  fail(scope: string, generation: number, error: string): void;
  lexical(scope: string, query: string, limit: number): RankedDocument[];
  semantic(scope: string, query: number[], identity: string, limit: number): RankedDocument[];
  read(scope: string, id: string): IndexedDocument | undefined;
  remove(scope: string): void;
  removeSource(sourceId: string): void;
}
export const contentKey = (text: string) => createHash('sha256').update(text).digest('hex');
function indexedText(text: string) {
  const normalized = text.normalize('NFKC').toLowerCase();
  const pairs: string[] = [];
  for (const segment of normalized.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu,
  ) ?? []) {
    const chars = [...segment];
    for (let i = 0; i < chars.length - 1; i++) pairs.push(chars[i]! + chars[i + 1]!);
  }
  return normalized + '\n' + pairs.join(' ');
}

export class SQLiteKnowledgeStore implements KnowledgeStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rag_status (scope TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rag_source_tombstones (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rag_chunks (scope TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL, metadata TEXT NOT NULL, vector_key TEXT NOT NULL, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS rag_vectors (scope TEXT NOT NULL, identity TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,identity,key));
      CREATE VIRTUAL TABLE IF NOT EXISTS rag_search USING fts5(scope UNINDEXED, id UNINDEXED, text, tokenize='unicode61');
    `);
  }
  status(scope: string): IndexStatus | undefined {
    const row = this.db.prepare('SELECT data FROM rag_status WHERE scope=?').get(scope);
    return row ? (JSON.parse(String(row.data)) as IndexStatus) : undefined;
  }
  private saveStatus(scope: string, state: IndexStatus) {
    this.db
      .prepare(
        'INSERT INTO rag_status VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data',
      )
      .run(scope, JSON.stringify(state));
  }
  private transaction<T>(execute: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = execute();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  begin(scope: string, version: string) {
    return this.transaction(() => {
      const previous = this.status(scope);
      const generation = (previous?.generation ?? 0) + 1;
      const sourceRevision = Number(
        this.db
          .prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM rag_source_tombstones')
          .get()!.revision,
      );
      this.saveStatus(scope, {
        state: 'building',
        generation,
        requestedVersion: version,
        activeVersion: previous?.activeVersion,
        chunks: previous?.chunks ?? 0,
        sourceRevision,
        updatedAt: new Date().toISOString(),
      });
      return generation;
    });
  }
  cached(scope: string, identity: string, texts: string[]) {
    const statement = this.db.prepare(
      'SELECT data FROM rag_vectors WHERE scope=? AND identity=? AND key=?',
    );
    return texts.map((text) => {
      const row = statement.get(scope, identity, contentKey(text));
      return row ? (JSON.parse(String(row.data)) as number[]) : undefined;
    });
  }
  publish(
    scope: string,
    generation: number,
    version: string,
    documents: IndexedDocument[],
    identity: string,
    vectors: number[][],
  ) {
    if (vectors.length && vectors.length !== documents.length)
      throw new Error('Incomplete embedding batch');
    if (new Set(documents.map((doc) => doc.id)).size !== documents.length)
      throw new Error('Duplicate knowledge source ID');
    for (const vector of vectors) validateVector(vector, vectors[0]?.length);
    this.transaction(() => {
      const status = this.status(scope);
      if (status?.generation !== generation || status.requestedVersion !== version)
        throw new Error('Index rebuild was superseded');
      const tombstone = this.db.prepare('SELECT revision FROM rag_source_tombstones WHERE id=?');
      if (
        documents.some(
          (doc) =>
            typeof doc.metadata.id === 'string' &&
            Number(tombstone.get(doc.metadata.id)?.revision ?? 0) > (status.sourceRevision ?? 0),
        )
      )
        throw new Error('Index source was deleted during rebuild; retry current sources');
      this.db.prepare('DELETE FROM rag_chunks WHERE scope=?').run(scope);
      this.db.prepare('DELETE FROM rag_search WHERE scope=?').run(scope);
      this.db.prepare('DELETE FROM rag_vectors WHERE scope=?').run(scope);
      const insert = this.db.prepare('INSERT INTO rag_chunks VALUES (?,?,?,?,?)');
      const fts = this.db.prepare('INSERT INTO rag_search VALUES (?,?,?)');
      const vectorInsert = this.db.prepare('INSERT OR IGNORE INTO rag_vectors VALUES (?,?,?,?)');
      documents.forEach((document, index) => {
        const key = contentKey(document.text);
        insert.run(scope, document.id, document.text, JSON.stringify(document.metadata), key);
        fts.run(
          scope,
          document.id,
          indexedText(
            [document.metadata.title, document.metadata.heading, document.text]
              .filter(Boolean)
              .join('\n'),
          ),
        );
        if (vectors[index]) vectorInsert.run(scope, identity, key, JSON.stringify(vectors[index]));
      });
      this.saveStatus(scope, {
        state: 'ready',
        generation,
        requestedVersion: version,
        activeVersion: version,
        chunks: documents.length,
        updatedAt: new Date().toISOString(),
      });
    });
  }
  fail(scope: string, generation: number, error: string) {
    this.transaction(() => {
      const status = this.status(scope);
      if (status?.generation === generation)
        this.saveStatus(scope, {
          ...status,
          state: 'failed',
          error: redactText(error).slice(0, 1000),
          updatedAt: new Date().toISOString(),
        });
    });
  }
  private decode(row: Record<string, unknown>): IndexedDocument {
    return {
      id: String(row.id),
      text: String(row.text),
      metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
    };
  }
  lexical(scope: string, query: string, limit: number): RankedDocument[] {
    const terms = searchTerms(query);
    if (!terms.length)
      return this.db
        .prepare('SELECT id,text,metadata FROM rag_chunks WHERE scope=? ORDER BY rowid LIMIT ?')
        .all(scope, limit)
        .map((row) => ({ ...this.decode(row), score: 0 }));
    const match = terms.map((term) => '"' + term.replaceAll('"', '""') + '"').join(' OR ');
    const rows = this.db
      .prepare(
        `SELECT id, bm25(rag_search) AS score FROM rag_search WHERE rag_search MATCH ? AND scope=? ORDER BY score LIMIT ?`,
      )
      .all(match, scope, limit);
    return rows.flatMap((row) => {
      const document = this.read(scope, String(row.id));
      return document ? [{ ...document, score: -Number(row.score) }] : [];
    });
  }
  semantic(scope: string, query: number[], identity: string, limit: number): RankedDocument[] {
    validateVector(query);
    return this.db
      .prepare(
        `SELECT c.id,c.text,c.metadata,v.data FROM rag_chunks c JOIN rag_vectors v ON c.scope=v.scope AND c.vector_key=v.key WHERE c.scope=? AND v.identity=?`,
      )
      .all(scope, identity)
      .map((row) => ({
        ...this.decode(row),
        score: cosine(JSON.parse(String(row.data)) as number[], query),
      }))
      .filter((row) => row.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  read(scope: string, id: string) {
    const row = this.db
      .prepare('SELECT id,text,metadata FROM rag_chunks WHERE scope=? AND id=?')
      .get(scope, id);
    return row ? this.decode(row) : undefined;
  }
  removeSource(sourceId: string) {
    this.transaction(() => {
      const revision = Number(
        this.db
          .prepare('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM rag_source_tombstones')
          .get()!.revision,
      );
      this.db
        .prepare(
          'INSERT INTO rag_source_tombstones VALUES (?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision',
        )
        .run(sourceId, revision);
    });
    const scopes = this.db
      .prepare("SELECT DISTINCT scope FROM rag_chunks WHERE json_extract(metadata,'$.id')=?")
      .all(sourceId);
    for (const row of scopes) this.remove(String(row.scope));
  }
  remove(scope: string) {
    this.transaction(() => {
      // Preserve the generation tombstone so an in-flight build cannot resurrect deleted data.
      const generation = (this.status(scope)?.generation ?? 0) + 1;
      this.db.prepare('DELETE FROM rag_chunks WHERE scope=?').run(scope);
      this.db.prepare('DELETE FROM rag_search WHERE scope=?').run(scope);
      this.db.prepare('DELETE FROM rag_vectors WHERE scope=?').run(scope);
      this.saveStatus(scope, {
        state: 'ready',
        generation,
        requestedVersion: '',
        chunks: 0,
        updatedAt: new Date().toISOString(),
      });
    });
  }
}
