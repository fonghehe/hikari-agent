import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SQLiteKnowledgeStore } from '../../packages/agent-runtime/src/knowledge/store';

const document = (id: string, text: string) => ({
  id,
  text,
  metadata: { name: 'manual.md', id: 'manual', index: 0 },
});
it('persists source citations, lexical search and exact vectors across reopening', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hikari-index-'));
  const filename = path.join(directory, 'knowledge.sqlite');
  try {
    const first = new DatabaseSync(filename);
    const store = new SQLiteKnowledgeStore(first);
    const job = store.begin('project-a', 'v1');
    store.publish(
      'project-a',
      job,
      'v1',
      [document('receipt', '退款必须提供原始收据。'), document('tea', 'Make green tea.')],
      'model',
      [
        [1, 0],
        [0, 1],
      ],
    );
    first.close();
    const second = new DatabaseSync(filename);
    try {
      const restored = new SQLiteKnowledgeStore(second);
      expect(restored.lexical('project-a', '原始收据', 10).map((item) => item.id)).toEqual([
        'receipt',
      ]);
      expect(restored.semantic('project-a', [1, 0], 'model', 10).map((item) => item.id)).toEqual([
        'receipt',
      ]);
      expect(restored.read('project-a', 'receipt')?.metadata.name).toBe('manual.md');
      expect(restored.read('project-b', 'receipt')).toBeUndefined();
      expect(restored.status('project-a')?.activeVersion).toBe('v1');
    } finally {
      second.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('publishes updates and removals atomically and keeps the active snapshot on failure', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new SQLiteKnowledgeStore(db);
    store.publish('a', store.begin('a', 'v1'), 'v1', [document('old', 'Legacy refunds')], '', []);
    const failed = store.begin('a', 'v2');
    store.fail('a', failed, 'provider unavailable');
    expect(store.read('a', 'old')?.text).toBe('Legacy refunds');
    expect(store.status('a')).toMatchObject({ state: 'failed', activeVersion: 'v1' });
    store.publish('a', store.begin('a', 'v3'), 'v3', [document('new', 'Current returns')], '', []);
    expect(store.read('a', 'old')).toBeUndefined();
    expect(store.lexical('a', 'Legacy', 10)).toEqual([]);
    const stale = store.begin('a', 'v4');
    const current = store.begin('a', 'v5');
    store.publish('a', current, 'v5', [], '', []);
    expect(() =>
      store.publish('a', stale, 'v4', [document('old', 'Legacy refunds')], '', []),
    ).toThrow('superseded');
    store.fail('a', stale, 'late failure');
    expect(store.status('a')).toMatchObject({ state: 'ready', activeVersion: 'v5', chunks: 0 });
    expect(store.read('a', 'new')).toBeUndefined();
  } finally {
    db.close();
  }
});

it('purges all indexed copies of a removed source while preserving unrelated scopes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new SQLiteKnowledgeStore(db);
    store.publish('a', store.begin('a', 'v1'), 'v1', [document('one', 'Private receipt')], '', []);
    store.publish(
      'b',
      store.begin('b', 'v1'),
      'v1',
      [{ id: 'two', text: 'Public receipt', metadata: { id: 'other' } }],
      '',
      [],
    );
    store.removeSource('manual');
    expect(store.lexical('a', 'receipt', 5)).toEqual([]);
    expect(store.lexical('b', 'receipt', 5)).toHaveLength(1);
  } finally {
    db.close();
  }
});

it('does not resurrect a deleted source from its first in-flight publication', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new SQLiteKnowledgeStore(db);
    const generation = store.begin('a', 'v1');
    store.removeSource('manual');
    expect(() =>
      store.publish('a', generation, 'v1', [document('one', 'Deleted receipt')], '', []),
    ).toThrow('deleted');
    expect(store.lexical('a', 'receipt', 5)).toEqual([]);
    store.publish(
      'a',
      store.begin('a', 'v2'),
      'v2',
      [document('new', 'Reimported receipt')],
      '',
      [],
    );
    expect(store.lexical('a', '', 5)).toHaveLength(1);
  } finally {
    db.close();
  }
});
