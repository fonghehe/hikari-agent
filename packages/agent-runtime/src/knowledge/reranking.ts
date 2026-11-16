import { z } from 'zod';
import { redactText } from '@hikari/agent-core';

export interface RerankingConfig {
  enabled: boolean;
  model: string;
  /** Full URL of a POST endpoint accepting query, documents, model and top_n. */
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}
export function retrievalEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error(
      'Retrieval services require HTTPS or a localhost endpoint without credentials or query parameters',
    );
  return url;
}
export async function rerankDocuments(
  config: RerankingConfig,
  query: string,
  documents: string[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const endpoint = retrievalEndpoint(config.baseUrl);
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      query: redactText(query, [config.apiKey]),
      documents: documents.map((text) => redactText(text, [config.apiKey])),
      top_n: documents.length,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs ?? 15000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Reranking service failed');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty reranking response');
  const buffers: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 2000000) throw new Error('Reranking response exceeds limit');
      buffers.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  signal.throwIfAborted();
  const result = z
    .object({
      results: z
        .array(z.object({ index: z.number().int().min(0), relevance_score: z.number().finite() }))
        .max(200),
    })
    .parse(JSON.parse(Buffer.concat(buffers).toString('utf8')));
  if (
    result.results.length !== documents.length ||
    new Set(result.results.map((item) => item.index)).size !== documents.length ||
    result.results.some((item) => item.index >= documents.length)
  )
    throw new Error('Invalid reranking result indices');
  return result.results.sort((a, b) => b.relevance_score - a.relevance_score);
}
