import { BaseRetriever } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { OpenAIEmbeddings } from '@langchain/openai';
import { createHash } from 'node:crypto';
import { AgentError, searchTerms } from '@hikari/agent-core';
export interface RetrievalDocument {
  text: string;
  metadata: Record<string, unknown>;
}
export interface VectorCache {
  get(key: string): number[] | undefined;
  put(key: string, value: number[]): void;
  putMany?(entries: [string, number[]][]): void;
}
export interface EmbeddingConfig {
  enabled: boolean;
  model: string;
  baseUrl: string;
  apiKey: string;
}
export function embeddingClient(config: EmbeddingConfig, signal: AbortSignal): EmbeddingsInterface {
  const url = new URL(config.baseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new AgentError('EMBEDDING_ENDPOINT', 'Embeddings require HTTPS or a localhost endpoint');
  return new OpenAIEmbeddings({
    model: config.model,
    apiKey: config.apiKey || 'local',
    batchSize: 32,
    maxRetries: 1,
    timeout: 60000,
    configuration: {
      baseURL: config.baseUrl,
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) }),
    },
  });
}
function cosine(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length || ![...a, ...b].every(Number.isFinite))
    throw new AgentError(
      'EMBEDDING_DIMENSION',
      'Embedding dimensions are invalid or changed; use a different model/cache identity',
    );
  let dot = 0,
    x = 0,
    y = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    x += a[i]! ** 2;
    y += b[i]! ** 2;
  }
  return x && y ? dot / Math.sqrt(x * y) : 0;
}
export class HybridRetriever extends BaseRetriever {
  lc_namespace = ['hikari', 'retrieval'];
  constructor(
    private documents: RetrievalDocument[],
    private limit = 8,
    private embeddings?: EmbeddingsInterface,
    private cache?: VectorCache,
    private identity = '',
    private signal = new AbortController().signal,
  ) {
    super();
  }
  async _getRelevantDocuments(query: string) {
    this.signal.throwIfAborted();
    const terms = searchTerms(query);
    const lexical = this.documents
      .map((doc, index) => ({
        index,
        score: terms.reduce(
          (n, term) => n + (doc.text.normalize('NFKC').toLowerCase().includes(term) ? 1 : 0),
          0,
        ),
      }))
      .filter((item) => item.score > 0 || !terms.length)
      .sort((a, b) => b.score - a.score);
    const ranking = new Map<number, number>();
    lexical.forEach((item, rank) => ranking.set(item.index, 1 / (60 + rank)));
    if (this.embeddings && this.documents.length) {
      if (
        this.documents.length > 2000 ||
        this.documents.reduce((n, doc) => n + doc.text.length, 0) > 3000000
      )
        throw new AgentError(
          'RETRIEVAL_LIMIT',
          'Semantic collection exceeds 2,000 chunks or 3 million characters. Split documents or disable embeddings for keyword search.',
        );
      const vectors: number[][] = [];
      // Hashes invalidate updated content; model+endpoint scope prevents stale cross-model vectors.
      for (let offset = 0; offset < this.documents.length; offset += 32) {
        this.signal.throwIfAborted();
        const batch = this.documents.slice(offset, offset + 32);
        const keys = batch.map((doc) =>
          createHash('sha256')
            .update(JSON.stringify([this.identity, doc.text]))
            .digest('hex'),
        );
        const values = keys.map((key) => this.cache?.get(key));
        const missing = values.flatMap((value, index) => (value ? [] : [index]));
        if (missing.length) {
          const fresh = await this.embeddings.embedDocuments(
            missing.map((index) => batch[index]!.text),
          );
          if (fresh.length !== missing.length)
            throw new AgentError(
              'EMBEDDING_RESPONSE',
              'Embedding endpoint returned an incomplete batch',
            );
          this.signal.throwIfAborted();
          const updates: [string, number[]][] = [];
          missing.forEach((index, position) => {
            values[index] = fresh[position]!;
            updates.push([keys[index]!, fresh[position]!]);
          });
          if (this.cache?.putMany) this.cache.putMany(updates);
          else for (const [key, value] of updates) this.cache?.put(key, value);
        }
        vectors.push(...(values as number[][]));
      }
      const q = await this.embeddings.embedQuery(query);
      this.signal.throwIfAborted();
      vectors
        .map((vector, index) => ({ index, score: cosine(vector, q) }))
        .filter((item) => item.score > 0.15)
        .sort((a, b) => b.score - a.score)
        .forEach((item, rank) =>
          ranking.set(item.index, (ranking.get(item.index) ?? 0) + 1 / (60 + rank)),
        );
    }
    return [...ranking]
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.limit)
      .map(
        ([index, score]) =>
          new Document({
            pageContent: this.documents[index]!.text,
            metadata: {
              ...this.documents[index]!.metadata,
              score,
              retrieval: this.embeddings ? 'hybrid' : 'keyword',
            },
          }),
      );
  }
}
export interface RetrievalOptions {
  embeddings?: EmbeddingConfig;
  cache?: VectorCache;
}
export async function retrieve(
  documents: RetrievalDocument[],
  query: string,
  limit: number,
  signal: AbortSignal,
  options?: RetrievalOptions,
) {
  const config = options?.embeddings?.enabled ? options.embeddings : undefined;
  const retriever = new HybridRetriever(
    documents,
    limit,
    config ? embeddingClient(config, signal) : undefined,
    options?.cache,
    config ? `${config.baseUrl}/${config.model}` : '',
    signal,
  );
  return (await retriever.invoke(query, { signal })).map((doc) => ({
    ...doc.metadata,
    text: doc.pageContent,
  }));
}
