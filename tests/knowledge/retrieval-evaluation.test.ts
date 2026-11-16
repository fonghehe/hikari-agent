import { expect, it } from 'vitest';
import { evaluateRetrieval } from '../../scripts/evals/retrieval';

it('retrieves the labelled multilingual sources and leaves unanswerable keyword queries empty', async () => {
  const report = await evaluateRetrieval();
  expect(report.failures).toEqual([]);
  expect(report.recallAt3).toBe(1);
  expect(report.noAnswerAccuracy).toBe(1);
  expect(report.liveModelsTested).toBe(false);
});
