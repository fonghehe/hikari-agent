import { BaseRetriever } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { OpenAIEmbeddings } from '@langchain/openai';
import { rerankDocuments, type RerankingConfig } from './reranking';
import { cosine } from './vectors';
import { knowledgeDocuments, knowledgeVersion, synchronizeKnowledgeIndex } from './indexer';
import type { KnowledgeStore } from './store';
import { AgentError, searchTerms, redactText } from '@hikari/agent-core';
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
  revision?: string;
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
        fetch(input, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        }),
    },
  });
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
    private pipeline: Pick<
      RetrievalOptions,
      'store' | 'namespace' | 'candidateLimit' | 'reranker' | 'maxOutputChars' | 'current'
    > = {},
  ) {
    super();
  }
  async _getRelevantDocuments(query: string) {
    this.signal.throwIfAborted();
    query = redactText(query);
    const documents = knowledgeDocuments(this.documents, this.pipeline.namespace);
    const assertSnapshot = () => {
      if (this.pipeline.current && !this.pipeline.current())
        throw new AgentError(
          'SOURCE_CHANGED',
          'Knowledge sources changed during retrieval; retry with current sources',
        );
      if (
        this.pipeline.store &&
        this.pipeline.store.status(this.pipeline.namespace ?? '')?.activeVersion !==
          knowledgeVersion(documents, this.embeddings ? this.identity : 'keyword')
      )
        throw new AgentError(
          'INDEX_SUPERSEDED',
          'Knowledge snapshot was superseded; retry the search against current sources',
        );
    };
    const candidateLimit = Math.max(this.limit, Math.min(200, this.pipeline.candidateLimit ?? 40));
    const vectors = await synchronizeKnowledgeIndex(
      documents,
      this.identity,
      this.signal,
      this.embeddings,
      this.cache,
      this.pipeline.store,
      this.pipeline.namespace,
      this.pipeline.current,
    );
    assertSnapshot();
    const indices = new Map(documents.map((doc, index) => [doc.id, index]));
    const terms = searchTerms(query);
    const lexical = this.pipeline.store
      ? this.pipeline.store
          .lexical(this.pipeline.namespace ?? '', query, candidateLimit)
          .map((doc) => ({ index: indices.get(doc.id)!, score: doc.score }))
      : documents
          .map((doc, index) => ({
            index,
            score: terms.reduce(
              (n, term) => n + (doc.text.normalize('NFKC').toLowerCase().includes(term) ? 1 : 0),
              0,
            ),
          }))
          .filter((item) => item.score > 0 || !terms.length)
          .sort((a, b) => b.score - a.score)
          .slice(0, candidateLimit);
    const ranking = new Map<number, number>();
    lexical.forEach((item, rank) => ranking.set(item.index, 1 / (60 + rank)));
    if (this.embeddings && documents.length) {
      const q = await this.embeddings.embedQuery(query);
      this.signal.throwIfAborted();
      assertSnapshot();
      const semantic = this.pipeline.store
        ? this.pipeline.store
            .semantic(this.pipeline.namespace ?? '', q, this.identity, candidateLimit)
            .map((doc) => ({ index: indices.get(doc.id)!, score: doc.score }))
        : vectors
            .map((vector, index) => ({ index, score: cosine(vector, q) }))
            .filter((item) => item.score > 0.15)
            .sort((a, b) => b.score - a.score)
            .slice(0, candidateLimit);
      semantic.forEach((item, rank) =>
        ranking.set(item.index, (ranking.get(item.index) ?? 0) + 1 / (60 + rank)),
      );
    }
    let candidates: Document[] = [...ranking]
      .sort((a, b) => b[1] - a[1])
      .slice(0, candidateLimit)
      .map(
        ([index, score]) =>
          new Document({
            pageContent: documents[index]!.text,
            metadata: {
              ...documents[index]!.metadata,
              citationId: documents[index]!.id,
              score,
              rerank: 'disabled',
              retrieval: this.embeddings ? 'hybrid' : 'keyword',
            },
          }),
      );
    if (this.pipeline.reranker?.enabled && candidates.length) {
      try {
        const order = await rerankDocuments(
          this.pipeline.reranker,
          query,
          candidates.map((doc) => doc.pageContent),
          this.signal,
        );
        candidates = order.map((item) => {
          const doc = candidates[item.index]!;
          doc.metadata = { ...doc.metadata, rerank: 'model', rerankScore: item.relevance_score };
          return doc;
        });
      } catch {
        this.signal.throwIfAborted();
        candidates.forEach((doc) => {
          doc.metadata = { ...doc.metadata, rerank: 'fallback', rerankError: 'RERANK_UNAVAILABLE' };
        });
      }
    }
    this.signal.throwIfAborted();
    assertSnapshot();
    let remaining = Math.max(1, Math.min(100000, this.pipeline.maxOutputChars ?? 24000)) - 2;
    return candidates.slice(0, this.limit).flatMap((doc) => {
      if (remaining <= 0) return [];
      const original = doc.pageContent;
      const encodedLength = (text: string) => JSON.stringify({ ...doc.metadata, text }).length;
      if (encodedLength(original) > remaining) {
        doc.metadata = { ...doc.metadata, truncated: true, originalLength: original.length };
        if (encodedLength('') > remaining) return [];
        let low = 0,
          high = original.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (encodedLength(original.slice(0, middle)) <= remaining) low = middle;
          else high = middle - 1;
        }
        doc.pageContent = original.slice(0, low).replace(/[\uD800-\uDBFF]$/, '');
      }
      remaining -= encodedLength(doc.pageContent) + 1;
      return [doc];
    });
  }
}
export interface RetrievalOptions {
  embeddings?: EmbeddingConfig;
  cache?: VectorCache;
  store?: KnowledgeStore;
  namespace?: string;
  candidateLimit?: number;
  maxOutputChars?: number;
  current?: () => boolean;
  reranker?: RerankingConfig;
}
export async function retrieve(
  documents: RetrievalDocument[],
  query: string,
  limit: number,
  signal: AbortSignal,
  options?: RetrievalOptions,
): Promise<(Record<string, unknown> & { text: string })[]> {
  const config = options?.embeddings?.enabled ? options.embeddings : undefined;
  const retriever = new HybridRetriever(
    documents,
    limit,
    config ? embeddingClient(config, signal) : undefined,
    options?.cache,
    config ? `${config.baseUrl}/${config.model}/${config.revision ?? ''}` : '',
    signal,
    options,
  );
  return (await retriever.invoke(query, { signal })).map((doc) => ({
    ...doc.metadata,
    text: doc.pageContent,
  }));
}
