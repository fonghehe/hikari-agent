import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { HybridRetriever } from '../../packages/agent-runtime/src/knowledge/retrieval';
import { SQLiteKnowledgeStore } from '../../packages/agent-runtime/src/knowledge/store';
import { retrievalCases, retrievalDocuments } from '../../tests/fixtures/retrieval-cases';

export async function evaluateRetrieval() {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new SQLiteKnowledgeStore(db);
    let recall = 0,
      reciprocalRank = 0,
      answerable = 0,
      noAnswerCorrect = 0,
      noAnswer = 0;
    const failures: string[] = [];
    const durations: number[] = [];
    for (const test of retrievalCases) {
      const start = performance.now();
      const hits = await new HybridRetriever(
        retrievalDocuments,
        3,
        undefined,
        undefined,
        '',
        undefined,
        { store, namespace: 'offline-evaluation' },
      ).invoke(test.query);
      durations.push(performance.now() - start);
      const ids = hits.map((hit) => String(hit.metadata.id));
      if (test.relevant.length) {
        answerable++;
        recall += test.relevant.filter((id) => ids.includes(id)).length / test.relevant.length;
        const first = ids.findIndex((id) => test.relevant.includes(id));
        reciprocalRank += first < 0 ? 0 : 1 / (first + 1);
        if (first < 0) failures.push(test.query);
      } else {
        noAnswer++;
        if (!hits.length) noAnswerCorrect++;
        else failures.push(test.query);
      }
    }
    durations.sort((a, b) => a - b);
    return {
      kind: 'synthetic-keyword-regression',
      backend: 'sqlite-exact-fts5',
      cases: retrievalCases.length,
      k: 3,
      recallAt3: recall / answerable,
      mrrAt3: reciprocalRank / answerable,
      noAnswerAccuracy: noAnswerCorrect / noAnswer,
      p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
      failures,
      liveModelsTested: false,
    };
  } finally {
    db.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await evaluateRetrieval();
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length) process.exitCode = 1;
}
