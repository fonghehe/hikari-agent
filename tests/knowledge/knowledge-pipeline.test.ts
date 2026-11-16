import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteKnowledgeStore } from '../../packages/agent-runtime/src/knowledge/store';
import { HybridRetriever } from '../../packages/agent-runtime/src/knowledge/retrieval';

it('reuses published embeddings, replaces stale chunks and emits stable scoped citations', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new SQLiteKnowledgeStore(db);
    let documentsEmbedded = 0;
    const embeddings = {
      embedDocuments: async (texts: string[]) => {
        documentsEmbedded += texts.length;
        return texts.map(() => [1, 0]);
      },
      embedQuery: async () => [1, 0],
    };
    const docs = [{ text: 'Original receipt required', metadata: { id: 'policy', index: 0 } }];
    const invoke = (values = docs, scope = 'project-a') =>
      new HybridRetriever(values, 6, embeddings, undefined, 'model-v1', undefined, {
        store,
        namespace: scope,
      }).invoke('receipt');
    const first = await invoke();
    const second = await invoke();
    expect(first[0]!.metadata.citationId).toBe(second[0]!.metadata.citationId);
    expect(documentsEmbedded).toBe(1);
    expect((await invoke(docs, 'project-b'))[0]!.metadata.citationId).not.toBe(
      first[0]!.metadata.citationId,
    );
    expect(documentsEmbedded).toBe(2);
    await invoke([{ text: 'Updated receipt policy', metadata: { id: 'policy', index: 0 } }]);
    expect(store.read('project-a', String(first[0]!.metadata.citationId))).toBeUndefined();
    await invoke([]);
    expect(store.status('project-a')?.chunks).toBe(0);
  } finally {
    db.close();
  }
});

it('keeps the last index after a failed rebuild but never serves it for a changed corpus', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new SQLiteKnowledgeStore(db);
    const embeddings = { embedDocuments: async () => [[1, 0]], embedQuery: async () => [1, 0] };
    const first = await new HybridRetriever(
      [{ text: 'old receipt', metadata: {} }],
      1,
      embeddings,
      undefined,
      'model',
      undefined,
      { store, namespace: 'a' },
    ).invoke('receipt');
    const broken = {
      ...embeddings,
      embedDocuments: async () => {
        throw new Error('offline');
      },
    };
    await expect(
      new HybridRetriever(
        [{ text: 'new receipt', metadata: {} }],
        1,
        broken,
        undefined,
        'model',
        undefined,
        { store, namespace: 'a' },
      ).invoke('receipt'),
    ).rejects.toThrow('offline');
    expect(store.status('a')).toMatchObject({ state: 'failed' });
    expect(store.read('a', String(first[0]!.metadata.citationId))?.text).toBe('old receipt');
  } finally {
    db.close();
  }
});

it('rejects a query whose snapshot was removed while the provider was in flight', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new SQLiteKnowledgeStore(db);
    const embeddings = {
      embedDocuments: async () => [[1, 0]],
      embedQuery: async () => {
        store.remove('a');
        return [1, 0];
      },
    };
    await expect(
      new HybridRetriever(
        [{ text: 'private receipt', metadata: { id: 'private' } }],
        1,
        embeddings,
        undefined,
        'model',
        undefined,
        { store, namespace: 'a' },
      ).invoke('receipt'),
    ).rejects.toThrow('superseded');
  } finally {
    db.close();
  }
});

it('counts metadata and JSON escaping against the final output budget', async () => {
  const result = await new HybridRetriever(
    [{ text: 'refund ' + '\\'.repeat(2000), metadata: { title: 'Policy'.repeat(300) } }],
    1,
    undefined,
    undefined,
    '',
    undefined,
    { maxOutputChars: 1500 },
  ).invoke('refund');
  expect(
    JSON.stringify(result.map((doc) => ({ ...doc.metadata, text: doc.pageContent }))).length,
  ).toBeLessThanOrEqual(1500);
  expect(result[0]?.metadata.truncated).toBe(true);
});

it('rejects a superseded keyword snapshot before mapping a competing corpus', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new SQLiteKnowledgeStore(db);
    const first = new HybridRetriever(
      [{ text: 'old receipt', metadata: {} }],
      1,
      undefined,
      undefined,
      '',
      undefined,
      { store, namespace: 'a' },
    ).invoke('receipt');
    const second = new HybridRetriever(
      [{ text: 'new receipt', metadata: {} }],
      1,
      undefined,
      undefined,
      '',
      undefined,
      { store, namespace: 'a' },
    ).invoke('receipt');
    await expect(first).rejects.toThrow('superseded');
    expect((await second)[0]?.pageContent).toBe('new receipt');
  } finally {
    db.close();
  }
});
