import { expect, it } from 'vitest';
import { assessReports } from '../../scripts/evals/report';
const gate = { minCases: 2, minSamples: 2, minSuccessRate: 0.9, maxP95Ms: 1000 };
const report = () => ({
  schemaVersion: 1,
  evidence: 'model-run',
  provider: 'compatible',
  model: 'fixture-only',
  workflow: 'standard',
  comparison: {
    configuration: 'a'.repeat(64),
    environment: 'b'.repeat(64),
    inputs: { one: 'c'.repeat(64), two: 'd'.repeat(64) },
  },
  results: ['one', 'two'].flatMap((name) =>
    [0, 1].map((sample) => ({
      case: name,
      sample,
      passed: true,
      durationMs: 100,
      validity: 'valid',
    })),
  ),
});
it('excludes invalid infrastructure runs from model scores and minimum sample counts', () => {
  const value = report();
  value.results[0] = { ...value.results[0]!, passed: false, validity: 'invalid' };
  const assessment = assessReports([value], gate);
  expect(assessment.successRate).toBe(1);
  expect(assessment.samples).toBe(3);
  expect(assessment).toMatchObject({ invalidSamples: 1, passed: false });
  expect(assessment.reasons).toContain('agent:one: need 2 samples');
});
it('rejects unclassified legacy evidence and mixed budgets or case inputs', () => {
  const old = { ...report(), schemaVersion: undefined };
  expect(() => assessReports([old], gate)).toThrow(/version|classified/i);
  const changed = report();
  changed.comparison.configuration = 'f'.repeat(64);
  expect(() => assessReports([report(), changed], gate)).toThrow(/configuration/i);
  const input = report();
  input.comparison.inputs.one = 'f'.repeat(64);
  expect(() => assessReports([report(), input], gate)).toThrow(/input/i);
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

it('rejects missing validity and mixed environments, and fails an entirely invalid run', () => {
  const unclassified = report();
  expect(() =>
    assessReports(
      [
        {
          ...unclassified,
          results: unclassified.results.map(({ validity: _validity, ...value }) => value),
        },
      ],
      gate,
    ),
  ).toThrow(/classified/);
  const environment = report();
  environment.comparison.environment = 'f'.repeat(64);
  expect(() => assessReports([report(), environment], gate)).toThrow(/environment/);
  const invalid = report();
  invalid.results = invalid.results.map((value) => ({
    ...value,
    passed: false,
    validity: 'invalid',
  }));
  expect(assessReports([invalid], gate)).toMatchObject({
    passed: false,
    samples: 0,
    invalidSamples: 4,
    cases: 0,
    successRate: 0,
  });
  expect(assessReports([invalid], gate).reasons).toContain('No valid samples');
  expect(() => assessReports([report(), report()], gate)).toThrow(/Duplicate/);
});

it('rejects duplicate report evidence even when object keys are reordered', () => {
  const original = report();
  function reorder(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reorder);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, item]) => [key, reorder(item)]),
      );
    return value;
  }
  const reordered = reorder(original);
  expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(original));
  expect(() => assessReports([original, reordered], { ...gate, minSamples: 4 })).toThrow(
    /Duplicate/,
  );
});
