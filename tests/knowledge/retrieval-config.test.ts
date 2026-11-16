import { expect, it } from 'vitest';
import { retrievalFromEnvironment } from '../../packages/agent-runtime/src/knowledge/config';
import { modelConfigSchema } from '../../packages/shared/src/index';

it('defaults all external retrieval off and uses separate trusted host credentials', () => {
  expect(retrievalFromEnvironment({})).toEqual({});
  const result = retrievalFromEnvironment({
    AGENT_EMBEDDING_MODEL: 'local-embed',
    AGENT_EMBEDDING_URL: 'http://localhost:8080/v1',
    AGENT_EMBEDDING_API_KEY: 'embed-secret',
    AGENT_RERANK_MODEL: 'local-rerank',
    AGENT_RERANK_URL: 'http://localhost:8080/rerank',
    AGENT_RERANK_API_KEY: 'rerank-secret',
  });
  expect(result.embeddings).toMatchObject({
    enabled: true,
    model: 'local-embed',
    apiKey: 'embed-secret',
  });
  expect(result.reranker).toMatchObject({
    enabled: true,
    model: 'local-rerank',
    apiKey: 'rerank-secret',
  });
  expect(() =>
    retrievalFromEnvironment({
      AGENT_RERANK_MODEL: 'model',
      AGENT_RERANK_URL: 'http://example.com/rerank',
    }),
  ).toThrow('HTTPS');
});
it('can save a disabled empty reranker but requires a model when enabled', () => {
  const value = {
    provider: 'compatible',
    model: 'chat',
    baseUrl: 'http://localhost:8080/v1',
    apiKey: '',
    reranker: { enabled: false, model: '', baseUrl: 'http://localhost:8080/rerank', apiKey: '' },
  };
  expect(modelConfigSchema.safeParse(value).success).toBe(true);
  expect(
    modelConfigSchema.safeParse({ ...value, reranker: { ...value.reranker, enabled: true } })
      .success,
  ).toBe(false);
});
