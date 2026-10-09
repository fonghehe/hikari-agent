import { it, expect } from 'vitest';
import { HybridRetriever } from '../packages/agent-runtime/src/retrieval';
import { searchMemory } from '../packages/agent-runtime/src/memory';
it('retrieves semantic synonyms, reuses vectors and invalidates changed content and model identity', async () => {
  const values = new Map<string, number[]>();
  let embedded = 0;
  const cache = {
    get: (key: string) => values.get(key),
    put: (key: string, value: number[]) => {
      values.set(key, value);
    },
  };
  const embeddings = {
    async embedDocuments(texts: string[]) {
      embedded += texts.length;
      return texts.map((text) => (text.includes('automobile') ? [1, 0] : [0, 1]));
    },
    async embedQuery() {
      return [1, 0];
    },
  };
  const documents = [
    { text: 'Repair an automobile engine', metadata: { source: 'manual', page: 3 } },
    { text: 'Make green tea', metadata: { source: 'cookbook', page: 1 } },
  ];
  const result = await new HybridRetriever(documents, 1, embeddings, cache, 'model-one').invoke(
    'car maintenance',
  );
  expect(result[0]?.metadata).toMatchObject({ source: 'manual', page: 3, retrieval: 'hybrid' });
  expect(embedded).toBe(2);
  await new HybridRetriever(documents, 1, embeddings, cache, 'model-one').invoke('engine');
  expect(embedded).toBe(2);
  await new HybridRetriever(
    [{ ...documents[0]!, text: 'automobile transmission' }, documents[1]!],
    1,
    embeddings,
    cache,
    'model-one',
  ).invoke('car');
  expect(embedded).toBe(3);
  await new HybridRetriever(documents, 1, embeddings, cache, 'model-two').invoke('car');
  expect(embedded).toBe(5);
});
it('supports multilingual keyword search offline and refuses invalid embeddings', async () => {
  const docs = [
    { text: '金额计算需要保留两位小数。', metadata: { id: 'zh' } },
    { text: '設定変更を保存します。', metadata: { id: 'ja' } },
  ];
  expect((await new HybridRetriever(docs).invoke('金额计算'))[0]?.metadata.id).toBe('zh');
  const embeddings = {
    embedDocuments: async () => [
      [1, 0],
      [1, 0],
    ],
    embedQuery: async () => [1],
  };
  await expect(new HybridRetriever(docs, 1, embeddings).invoke('save')).rejects.toThrow(
    'dimensions',
  );
  const signal = AbortSignal.abort();
  await expect(
    new HybridRetriever(docs, 1, undefined, undefined, '', signal).invoke('save'),
  ).rejects.toThrow();
});
it('excludes expired memory without deleting the user-visible entry', () => {
  const entry = {
    id: 'one',
    title: 'fact',
    content: 'saved fact',
    updatedAt: new Date().toISOString(),
  };
  expect(
    searchMemory(
      [
        { ...entry, expiresAt: '2000-01-01T00:00:00.000Z' },
        { ...entry, id: 'two' },
      ],
      'fact',
    ),
  ).toHaveLength(1);
});
it('persists a document batch together and discards embedding results after cancellation', async () => {
  let writes = 0;
  const cache = {
    get: () => undefined,
    put: () => {
      throw new Error('per-vector write');
    },
    putMany: (values: [string, number[]][]) => {
      writes++;
      expect(values).toHaveLength(32);
    },
  };
  const documents = Array.from({ length: 64 }, (_, index) => ({
    text: `document ${index}`,
    metadata: { index },
  }));
  const embeddings = {
    embedDocuments: async (texts: string[]) => texts.map(() => [1, 0]),
    embedQuery: async () => [1, 0],
  };
  await new HybridRetriever(documents, 8, embeddings, cache).invoke('document');
  expect(writes).toBe(2);
  const controller = new AbortController();
  const cancelled = {
    ...embeddings,
    embedDocuments: async (texts: string[]) => {
      controller.abort();
      return texts.map(() => [1, 0]);
    },
  };
  await expect(
    new HybridRetriever(documents, 8, cancelled, cache, '', controller.signal).invoke('document'),
  ).rejects.toThrow();
  expect(writes).toBe(2);
});
