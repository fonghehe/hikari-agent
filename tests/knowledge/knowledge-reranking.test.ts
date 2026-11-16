import { afterEach, expect, it, vi } from 'vitest';
import { HybridRetriever } from '../../packages/agent-runtime/src/knowledge/retrieval';

afterEach(() => vi.unstubAllGlobals());
const config = {
  enabled: true,
  model: 'test-reranker',
  baseUrl: 'http://localhost:1234/rerank',
  apiKey: '',
};
const docs = [
  { text: 'Refund general information', metadata: { id: 'general' } },
  { text: 'Refund receipt required for opened products', metadata: { id: 'specific' } },
];
it('reranks a larger candidate pool before final top-k truncation', async () => {
  let payload: { query: string; documents: string[] } | undefined;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    payload = JSON.parse(String(init.body));
    expect(init.redirect).toBe('error');
    return Response.json({
      results: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.1 },
      ],
    });
  });
  const result = await new HybridRetriever(docs, 1, undefined, undefined, '', undefined, {
    reranker: config,
    candidateLimit: 20,
  }).invoke('refund');
  expect(payload?.documents).toHaveLength(2);
  expect(result[0]!.metadata).toMatchObject({ id: 'specific', rerank: 'model', rerankScore: 0.9 });
});
it('reports malformed reranker fallback without changing fused order or leaking provider text', async () => {
  vi.stubGlobal('fetch', async () =>
    Response.json({ results: [{ index: 999, relevance_score: 1 }] }),
  );
  const result = await new HybridRetriever(docs, 1, undefined, undefined, '', undefined, {
    reranker: config,
  }).invoke('refund');
  expect(result[0]!.metadata).toMatchObject({
    id: 'general',
    rerank: 'fallback',
    rerankError: 'RERANK_UNAVAILABLE',
  });
});
it('propagates cancellation instead of returning a degraded success', async () => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', async () => {
    controller.abort();
    throw new Error('cancelled');
  });
  await expect(
    new HybridRetriever(docs, 1, undefined, undefined, '', controller.signal, {
      reranker: config,
    }).invoke('refund'),
  ).rejects.toThrow();
});
