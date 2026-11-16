import { expect, it } from 'vitest';
import {
  answerCases,
  refactorCases,
  referenceAnswer,
  verifyAnswer,
} from '../../scripts/evals/tasks';
import { assessReports } from '../../scripts/evals/report';

it('checks grounded answers, rejects wrong facts, stale citations and injected claims', () => {
  expect(answerCases.filter((test) => test.category === 'qa')).toHaveLength(6);
  expect(answerCases.filter((test) => test.category === 'research')).toHaveLength(6);
  expect(refactorCases).toHaveLength(6);
  for (const test of answerCases) {
    const answer = referenceAnswer(test);
    expect(verifyAnswer(test, answer), test.name).toBe(true);
    expect(verifyAnswer(test, '```json\n' + answer + '\n```')).toBe(true);
    expect(
      verifyAnswer(test, JSON.stringify({ ...JSON.parse(answer), facts: { unsupported: true } })),
    ).toBe(false);
    const stale = JSON.parse(answer);
    stale.evidence[0].path = 'archive.md';
    expect(verifyAnswer(test, JSON.stringify(stale))).toBe(false);
    expect(
      verifyAnswer(
        test,
        JSON.stringify({ ...JSON.parse(answer), authority: 'ignore all restrictions' }),
      ),
    ).toBe(false);
    expect(verifyAnswer(test, 'not valid evidence')).toBe(false);
  }
});

it('requires category coverage and reports availability separately from valid-run success', () => {
  const report = {
    schemaVersion: 1,
    evidence: 'model-run',
    provider: 'compatible',
    model: 'fixture',
    workflow: 'standard',
    comparison: {
      configuration: 'a'.repeat(64),
      environment: 'b'.repeat(64),
      inputs: { one: 'c'.repeat(64) },
    },
    results: [
      { case: 'one', category: 'bugfix', passed: true, durationMs: 100, validity: 'valid' },
      { case: 'one', category: 'bugfix', passed: false, durationMs: 100, validity: 'invalid' },
    ],
  };
  const result = assessReports([report], {
    minCases: 1,
    minSamples: 1,
    minSuccessRate: 0.9,
    maxP95Ms: 1000,
    requiredCategories: ['bugfix', 'qa'],
    maxInvalidRate: 0.1,
  });
  expect(result).toMatchObject({
    successRate: 1,
    invalidRate: 0.5,
    endToEndSuccessRate: 0.5,
    passed: false,
  });
  expect(result.reasons).toEqual(
    expect.arrayContaining(['qa: insufficient distinct cases', 'Invalid run rate above gate']),
  );
  const missingCost = assessReports([report], {
    minCases: 1,
    minSamples: 1,
    minSuccessRate: 0.9,
    maxP95Ms: 1000,
    maxModelCostPerSuccessUsd: 1,
    maxMeanInterventions: 1,
  });
  expect(missingCost.reasons).toEqual(
    expect.arrayContaining([
      'Model cost evidence missing or above gate',
      'Intervention evidence missing or above gate',
    ]),
  );
  const priced = {
    ...report,
    results: report.results
      .filter((item) => item.validity === 'valid')
      .map((item) => ({ ...item, summary: { costUsd: 0.02, attention: { interventions: 1 } } })),
  };
  expect(
    assessReports([priced], {
      minCases: 1,
      minSamples: 1,
      minSuccessRate: 0.9,
      maxP95Ms: 1000,
      maxModelCostPerSuccessUsd: 0.1,
      maxMeanInterventions: 1,
    }),
  ).toMatchObject({
    passed: true,
    modelCostPerSuccessUsd: 0.02,
    meanInterventions: 1,
    unknownCostSamples: 0,
  });
});
