import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from './evidence';

export interface EvaluationGate {
  minCases: number;
  minSamples: number;
  minSuccessRate: number;
  maxP95Ms: number;
  requiredCategories?: string[];
  minCasesPerCategory?: number;
  maxInvalidRate?: number;
  maxModelCostPerSuccessUsd?: number;
  maxMeanInterventions?: number;
}

/** Deliberately accepts model-run evidence only; grader validation is not model evaluation. */
export function assessReports(reports: unknown[], gate: EvaluationGate) {
  if (
    !Number.isInteger(gate.minCases) ||
    gate.minCases < 1 ||
    !Number.isInteger(gate.minSamples) ||
    gate.minSamples < 1 ||
    !Number.isFinite(gate.minSuccessRate) ||
    gate.minSuccessRate < 0 ||
    gate.minSuccessRate > 1 ||
    !Number.isFinite(gate.maxP95Ms) ||
    gate.maxP95Ms <= 0 ||
    (gate.maxInvalidRate !== undefined &&
      (!Number.isFinite(gate.maxInvalidRate) ||
        gate.maxInvalidRate < 0 ||
        gate.maxInvalidRate > 1)) ||
    (gate.minCasesPerCategory !== undefined &&
      (!Number.isInteger(gate.minCasesPerCategory) || gate.minCasesPerCategory < 1)) ||
    [gate.maxModelCostPerSuccessUsd, gate.maxMeanInterventions].some(
      (value) => value !== undefined && (!Number.isFinite(value) || value < 0),
    )
  )
    throw new Error('Invalid evaluation gate');
  const cases = new Map<string, { passed: boolean; durationMs: number }[]>();
  const identities = new Set<string>();
  const comparisons = new Map<
    string,
    { configuration: string; environment: string; input: string }
  >();
  let invalidSamples = 0;
  const categories = new Map<string, Set<string>>();
  let knownModelCostUsd = 0,
    unknownCostSamples = 0,
    interventions = 0,
    unknownAttentionSamples = 0;
  if (new Set(reports.map(fingerprint)).size !== reports.length)
    throw new Error('Duplicate report contents');
  for (const value of reports) {
    if (!value || typeof value !== 'object') throw new Error('Invalid report');
    const report = value as Record<string, unknown>;
    if (
      report.evidence !== 'model-run' ||
      typeof report.provider !== 'string' ||
      !report.provider ||
      report.provider === 'demo' ||
      typeof report.model !== 'string' ||
      !report.model ||
      !['standard', 'development'].includes(String(report.workflow)) ||
      !Array.isArray(report.results) ||
      !report.results.length
    )
      throw new Error(
        'Only nonempty real-model reports with provider, model and workflow are accepted',
      );
    if (report.schemaVersion !== 1) throw new Error('A versioned, classified report is required');
    const comparison = report.comparison as Record<string, unknown> | undefined;
    const inputs = comparison?.inputs as Record<string, unknown> | undefined;
    const hash = (value: unknown): value is string =>
      typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (
      !hash(comparison?.configuration) ||
      !hash(comparison?.environment) ||
      !inputs ||
      typeof inputs !== 'object'
    )
      throw new Error('Reports require configuration, environment and input fingerprints');
    identities.add(JSON.stringify([report.provider, report.model, report.workflow]));
    for (const value of report.results) {
      if (!value || typeof value !== 'object') throw new Error('Invalid result');
      const result = value as Record<string, unknown>;
      if (
        typeof result.case !== 'string' ||
        !result.case ||
        typeof result.passed !== 'boolean' ||
        typeof result.durationMs !== 'number' ||
        !Number.isFinite(result.durationMs) ||
        result.durationMs < 0
      )
        throw new Error('Results require case, passed and finite durationMs');
      const key = `${String(report.suite ?? 'agent')}:${result.case}`;
      if (!['valid', 'invalid'].includes(String(result.validity)))
        throw new Error('Results must be classified valid or invalid');
      const input = inputs[result.case];
      if (!hash(input)) throw new Error('Missing case input fingerprint');
      const previous = comparisons.get(key);
      if (previous?.configuration && previous.configuration !== comparison.configuration)
        throw new Error(`${key}: mixed configuration fingerprints`);
      if (previous?.environment && previous.environment !== comparison.environment)
        throw new Error(`${key}: mixed environment fingerprints`);
      if (previous?.input && previous.input !== input)
        throw new Error(`${key}: mixed input fingerprints`);
      comparisons.set(key, {
        configuration: comparison.configuration,
        environment: comparison.environment,
        input,
      });
      const samples = cases.get(key) ?? [];
      if (result.validity === 'invalid') invalidSamples++;
      else {
        samples.push({ passed: result.passed, durationMs: result.durationMs });
        const summary = result.summary as
          | { costUsd?: number; attention?: { interventions?: number } }
          | undefined;
        if (
          typeof summary?.costUsd === 'number' &&
          Number.isFinite(summary.costUsd) &&
          summary.costUsd >= 0
        )
          knownModelCostUsd += summary.costUsd;
        else unknownCostSamples++;
        if (
          typeof summary?.attention?.interventions === 'number' &&
          Number.isFinite(summary.attention.interventions) &&
          summary.attention.interventions >= 0
        )
          interventions += summary.attention.interventions;
        else unknownAttentionSamples++;
        if (typeof result.category === 'string') {
          const entries = categories.get(result.category) ?? new Set<string>();
          entries.add(key);
          categories.set(result.category, entries);
        }
      }
      cases.set(key, samples);
    }
  }
  if (identities.size !== 1) throw new Error('Compare one provider/model/workflow at a time');
  const results = [...cases.values()].flat();
  const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
  const successRate = results.filter((result) => result.passed).length / (results.length || 1);
  const p95Ms = durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0;
  const reasons: string[] = [];
  const validCases = [...cases.values()].filter((samples) => samples.length > 0).length;
  if (!results.length) reasons.push('No valid samples');
  if (validCases < gate.minCases) reasons.push(`Need at least ${gate.minCases} distinct cases`);
  for (const [name, samples] of cases) {
    if (samples.length < gate.minSamples) reasons.push(`${name}: need ${gate.minSamples} samples`);
    if (samples.filter((item) => item.passed).length / samples.length < gate.minSuccessRate)
      reasons.push(`${name}: success rate below gate`);
  }
  if (successRate < gate.minSuccessRate) reasons.push('Overall success rate below gate');
  if (p95Ms > gate.maxP95Ms) reasons.push('P95 latency above gate');
  const invalidRate = invalidSamples / (results.length + invalidSamples || 1);
  if (invalidRate > (gate.maxInvalidRate ?? 1)) reasons.push('Invalid run rate above gate');
  for (const category of gate.requiredCategories ?? [])
    if ((categories.get(category)?.size ?? 0) < (gate.minCasesPerCategory ?? 1))
      reasons.push(`${category}: insufficient distinct cases`);
  const successes = results.filter((result) => result.passed).length;
  const modelCostPerSuccessUsd = successes ? knownModelCostUsd / successes : undefined;
  const meanInterventions = results.length ? interventions / results.length : undefined;
  if (
    gate.maxModelCostPerSuccessUsd !== undefined &&
    (unknownCostSamples > 0 ||
      modelCostPerSuccessUsd === undefined ||
      modelCostPerSuccessUsd > gate.maxModelCostPerSuccessUsd)
  )
    reasons.push('Model cost evidence missing or above gate');
  if (
    gate.maxMeanInterventions !== undefined &&
    (unknownAttentionSamples > 0 ||
      meanInterventions === undefined ||
      meanInterventions > gate.maxMeanInterventions)
  )
    reasons.push('Intervention evidence missing or above gate');
  return {
    passed: reasons.length === 0,
    cases: validCases,
    invalidSamples,
    invalidRate,
    endToEndSuccessRate:
      results.filter((result) => result.passed).length / (results.length + invalidSamples || 1),
    categories: Object.fromEntries([...categories].map(([name, values]) => [name, values.size])),
    knownModelCostUsd,
    unknownCostSamples,
    modelCostPerSuccessUsd,
    meanInterventions,
    unknownAttentionSamples,
    samples: results.length,
    successRate,
    p95Ms,
    reasons,
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log(
      'Usage: pnpm eval:report REPORT.json [REPORT.json ...]\nGate environment: EVAL_MIN_CASES=5 EVAL_MIN_SAMPLES=3 EVAL_MIN_SUCCESS_RATE=0.9 EVAL_MAX_P95_MS=180000 EVAL_MAX_INVALID_RATE=0.1 EVAL_REQUIRED_CATEGORIES=bugfix,refactor,qa,research EVAL_MIN_CATEGORY_CASES=1\nOnly model-run reports for one provider/model/workflow are accepted. Reports do not independently prove a real API call.',
    );
    return;
  }
  if (!args.length || args.some((arg) => arg.startsWith('--')))
    throw new Error('Provide real-model report JSON files; use --help');
  const files = [...new Set(args.map((arg) => path.resolve(arg)))];
  const reports = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(file, 'utf8')) as unknown),
  );
  // Identical copied reports must not increase the sample count.
  if (new Set(reports.map(fingerprint)).size !== reports.length)
    throw new Error('Duplicate report contents');
  const result = assessReports(reports, {
    minCases: Number(process.env.EVAL_MIN_CASES ?? 5),
    minSamples: Number(process.env.EVAL_MIN_SAMPLES ?? 3),
    minSuccessRate: Number(process.env.EVAL_MIN_SUCCESS_RATE ?? 0.9),
    maxP95Ms: Number(process.env.EVAL_MAX_P95_MS ?? 180000),
    maxInvalidRate: Number(process.env.EVAL_MAX_INVALID_RATE ?? 0.1),
    requiredCategories: (process.env.EVAL_REQUIRED_CATEGORIES ?? 'bugfix,refactor,qa,research')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    minCasesPerCategory: Number(process.env.EVAL_MIN_CATEGORY_CASES ?? 1),
    maxModelCostPerSuccessUsd:
      process.env.EVAL_MAX_MODEL_COST_PER_SUCCESS_USD === undefined
        ? undefined
        : Number(process.env.EVAL_MAX_MODEL_COST_PER_SUCCESS_USD),
    maxMeanInterventions:
      process.env.EVAL_MAX_MEAN_INTERVENTIONS === undefined
        ? undefined
        : Number(process.env.EVAL_MAX_MEAN_INTERVENTIONS),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Invalid report');
    process.exitCode = 2;
  });
