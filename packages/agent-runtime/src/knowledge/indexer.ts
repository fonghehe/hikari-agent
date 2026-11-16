import { createHash } from 'node:crypto';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { AgentError, redact, redactText } from '@hikari/agent-core';
import type { RetrievalDocument, VectorCache } from './retrieval';
import type { IndexedDocument, KnowledgeStore } from './store';
import { validateVector } from './vectors';

export function knowledgeDocuments(
  documents: RetrievalDocument[],
  namespace = '',
): IndexedDocument[] {
  return [
    ...new Map(
      documents.map((document) => {
        const text = redactText(document.text);
        const redacted = redact(document.metadata) as Record<string, unknown>;
        const metadata = Object.fromEntries(
          Object.entries(redacted)
            .slice(0, 32)
            .filter(([key]) => !['text', 'content'].includes(key))
            .map(([key, value]) => [
              key.slice(0, 80),
              typeof value === 'string'
                ? value.slice(0, 1000)
                : JSON.stringify(value ?? null).length > 2000
                  ? '[Metadata omitted: size limit]'
                  : value,
            ]),
        );
        const id = createHash('sha256')
          .update(JSON.stringify([namespace, metadata, text]))
          .digest('hex');
        return [id, { id, text, metadata }] as const;
      }),
    ).values(),
  ];
}

export function knowledgeVersion(documents: IndexedDocument[], identity: string) {
  return createHash('sha256')
    .update(JSON.stringify([identity, documents]))
    .digest('hex');
}

/** Build off the active snapshot; only a complete, uncancelled build is published. */
export async function synchronizeKnowledgeIndex(
  documents: IndexedDocument[],
  identity: string,
  signal: AbortSignal,
  embeddings?: EmbeddingsInterface,
  cache?: VectorCache,
  store?: KnowledgeStore,
  namespace = '',
  current?: () => boolean,
) {
  signal.throwIfAborted();
  if (
    embeddings &&
    (documents.length > 2000 || documents.reduce((n, doc) => n + doc.text.length, 0) > 3000000)
  )
    throw new AgentError(
      'RETRIEVAL_LIMIT',
      'Semantic collection exceeds 2,000 chunks or 3 million characters. Split documents or disable embeddings for keyword search.',
    );
  const version = knowledgeVersion(documents, embeddings ? identity : 'keyword');
  if (store?.status(namespace)?.activeVersion === version) return [] as number[][];
  const generation = store?.begin(namespace, version);
  try {
    const vectors: number[][] = [];
    if (embeddings)
      for (let offset = 0; offset < documents.length; offset += 32) {
        signal.throwIfAborted();
        const batch = documents.slice(offset, offset + 32);
        const keys = batch.map((doc) =>
          createHash('sha256')
            .update(JSON.stringify([identity, doc.text]))
            .digest('hex'),
        );
        const persisted = store?.cached(
          namespace,
          identity,
          batch.map((doc) => doc.text),
        );
        const values = keys.map((key, i) => persisted?.[i] ?? cache?.get(key));
        const missing = values.flatMap((value, index) => (value ? [] : [index]));
        if (missing.length) {
          const fresh = await embeddings.embedDocuments(missing.map((index) => batch[index]!.text));
          if (fresh.length !== missing.length)
            throw new AgentError(
              'EMBEDDING_RESPONSE',
              'Embedding endpoint returned an incomplete batch',
            );
          signal.throwIfAborted();
          const updates: [string, number[]][] = [];
          missing.forEach((index, position) => {
            validateVector(fresh[position]!);
            values[index] = fresh[position]!;
            updates.push([keys[index]!, fresh[position]!]);
          });
          // The durable store publishes vectors together with their source snapshot.
          if (!store) {
            if (cache?.putMany) cache.putMany(updates);
            else for (const [key, value] of updates) cache?.put(key, value);
          }
        }
        for (const value of values) validateVector(value!, vectors[0]?.length ?? values[0]?.length);
        vectors.push(...(values as number[][]));
      }
    signal.throwIfAborted();
    if (current && !current())
      throw new AgentError(
        'SOURCE_CHANGED',
        'Knowledge sources changed during indexing; retry with current sources',
      );
    store?.publish(namespace, generation!, version, documents, embeddings ? identity : '', vectors);
    return vectors;
  } catch (error) {
    store?.fail(
      namespace,
      generation!,
      error instanceof Error ? error.message : 'Index build failed',
    );
    throw error;
  }
}
