import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ToolRegistry } from '../../packages/agent-runtime/src/index';
import { SQLiteKnowledgeStore } from '../../packages/agent-runtime/src/knowledge/store';
import { registerMemoryTools } from '../../packages/agent-runtime/src/context/saved-memory';

it('keeps local memory search usable with remote providers and validates source access against current records', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const registry = new ToolRegistry();
    let entries = [
      {
        id: 'one',
        title: 'Refund policy',
        content: 'Original receipt required',
        updatedAt: new Date().toISOString(),
      },
    ];
    registerMemoryTools(registry, { list: () => entries, put() {}, remove() {} }, 'project-a', {
      store: new SQLiteKnowledgeStore(db),
      namespace: 'project-a',
      embeddings: {
        enabled: true,
        model: 'model',
        baseUrl: 'https://example.invalid/v1',
        apiKey: '',
      },
    });
    const context = {
      taskId: 'task',
      workspace: 'project-a',
      signal: new AbortController().signal,
      events: { emit() {} },
    };
    const local = registry.get('search_memory_local');
    expect(local.permission).toBe('filesystem.read');
    const result = JSON.parse(
      (await local.execute(local.parse({ query: 'receipt' }), context)).content,
    );
    expect(result[0]).toMatchObject({
      text: 'Refund policy\nOriginal receipt required',
      retrieval: 'keyword',
    });
    const reader = registry.get('read_memory_source');
    expect(
      JSON.parse(
        (await reader.execute(reader.parse({ citationId: result[0].citationId }), context)).content,
      ).text,
    ).toContain('Original receipt');
    entries = [];
    await expect(
      reader.execute(reader.parse({ citationId: result[0].citationId }), context),
    ).rejects.toThrow('unavailable');
    const status = registry.get('get_memory_index_status');
    expect(JSON.parse((await status.execute({}, context)).content).backend).toBe('sqlite-exact');
  } finally {
    db.close();
  }
});

it('does not return a source that expired during an external request', async () => {
  const { vi } = await import('vitest');
  const db = new DatabaseSync(':memory:');
  let current = Date.now();
  const now = vi.spyOn(Date, 'now').mockImplementation(() => current);
  try {
    const registry = new ToolRegistry();
    const entries = [
      {
        id: 'one',
        title: 'Refund policy',
        content: 'Original receipt required',
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(current + 1000).toISOString(),
      },
    ];
    const store = new SQLiteKnowledgeStore(db);
    registerMemoryTools(registry, { list: () => entries, put() {}, remove() {} }, 'a', {
      store,
      namespace: 'a',
      reranker: { enabled: true, model: 'test', baseUrl: 'http://localhost/rerank', apiKey: '' },
    });
    vi.stubGlobal('fetch', async () => {
      current += 2000;
      return Response.json({ results: [{ index: 0, relevance_score: 1 }] });
    });
    const tool = registry.get('search_memory');
    await expect(
      tool.execute(tool.parse({ query: 'receipt' }), {
        taskId: 'task',
        workspace: 'a',
        signal: new AbortController().signal,
        events: { emit() {} },
      }),
    ).rejects.toThrow('changed');
  } finally {
    now.mockRestore();
    vi.unstubAllGlobals();
    db.close();
  }
});

it('uses the exact captured source array when expiry crosses the snapshot boundary', async () => {
  const { vi } = await import('vitest');
  const db = new DatabaseSync(':memory:');
  const before = Date.now();
  const expiresAt = new Date(before + 1000).toISOString();
  const now = vi
    .spyOn(Date, 'now')
    .mockReturnValueOnce(before)
    .mockReturnValue(before + 2000);
  try {
    const registry = new ToolRegistry();
    const store = new SQLiteKnowledgeStore(db);
    registerMemoryTools(
      registry,
      {
        list: () => [
          { id: 'one', title: 'Refund', content: 'receipt', updatedAt: '2026-01-01', expiresAt },
        ],
        put() {},
        remove() {},
      },
      'a',
      { store, namespace: 'a' },
    );
    const tool = registry.get('search_memory');
    await expect(
      tool.execute(tool.parse({ query: 'receipt' }), {
        taskId: 'task',
        workspace: 'a',
        signal: new AbortController().signal,
        events: { emit() {} },
      }),
    ).rejects.toThrow('changed');
    expect(store.lexical('a:memory', 'receipt', 5)).toEqual([]);
  } finally {
    now.mockRestore();
    db.close();
  }
});
