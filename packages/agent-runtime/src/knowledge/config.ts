import { z } from 'zod';
import type { RetrievalOptions } from './retrieval';
import { retrievalEndpoint } from './reranking';

/** Local host configuration only; never accept provider credentials from a remote job. */
export function retrievalFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): Pick<RetrievalOptions, 'embeddings' | 'reranker'> {
  const result: Pick<RetrievalOptions, 'embeddings' | 'reranker'> = {};
  if (environment.AGENT_EMBEDDING_MODEL && environment.AGENT_EMBEDDINGS !== 'false') {
    result.embeddings = {
      enabled: true,
      model: z.string().min(1).max(120).parse(environment.AGENT_EMBEDDING_MODEL),
      baseUrl: retrievalEndpoint(environment.AGENT_EMBEDDING_URL ?? 'https://api.openai.com/v1')
        .toString()
        .replace(/\/$/, ''),
      apiKey: z
        .string()
        .max(1000)
        .parse(environment.AGENT_EMBEDDING_API_KEY ?? ''),
      revision: environment.AGENT_EMBEDDING_REVISION,
    };
  }
  if (environment.AGENT_RERANK_MODEL && environment.AGENT_RERANK_ENABLED !== 'false') {
    result.reranker = {
      enabled: true,
      model: z.string().min(1).max(120).parse(environment.AGENT_RERANK_MODEL),
      baseUrl: retrievalEndpoint(environment.AGENT_RERANK_URL ?? '').toString(),
      apiKey: z
        .string()
        .max(1000)
        .parse(environment.AGENT_RERANK_API_KEY ?? ''),
      timeoutMs: z.coerce
        .number()
        .int()
        .min(1000)
        .max(60000)
        .parse(environment.AGENT_RERANK_TIMEOUT_MS ?? 15000),
    };
  }
  return result;
}
