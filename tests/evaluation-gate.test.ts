import { expect, it } from 'vitest';
import { assessReports } from '../scripts/evals/report';
const gate = { minCases: 2, minSamples: 2, minSuccessRate: 0.9, maxP95Ms: 1000 };
const report = () => ({
  evidence: 'model-run',
  provider: 'compatible',
  model: 'fixture-only',
  workflow: 'standard',
  results: ['one', 'two'].flatMap((name) =>
    [0, 1].map((sample) => ({ case: name, sample, passed: true, durationMs: 100 })),
  ),
});
it('rejects fixture/baseline evidence and mixed model identities', () => {
  expect(() => assessReports([{ ...report(), evidence: 'baseline-only' }], gate)).toThrow(
    'real-model',
  );
  expect(() => assessReports([{ ...report(), provider: 'demo' }], gate)).toThrow('real-model');
  expect(() => assessReports([report(), { ...report(), model: 'other' }], gate)).toThrow(
    'one provider',
  );
});
it('evaluates each case and latency rather than allowing aggregate success to hide failures', () => {
  expect(assessReports([report()], gate).passed).toBe(true);
  const failed = report();
  failed.results[0]!.passed = false;
  expect(assessReports([failed], gate).passed).toBe(false);
  const slow = report();
  slow.results[0]!.durationMs = 1001;
  expect(assessReports([slow], gate).reasons).toContain('P95 latency above gate');
  expect(assessReports([report()], { ...gate, minSamples: 3 }).passed).toBe(false);
});
