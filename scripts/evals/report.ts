import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EvaluationGate {
  minCases: number;
  minSamples: number;
  minSuccessRate: number;
  maxP95Ms: number;
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
    gate.maxP95Ms <= 0
  )
    throw new Error('Invalid evaluation gate');
  const cases = new Map<string, { passed: boolean; durationMs: number }[]>();
  const identities = new Set<string>();
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
      const samples = cases.get(key) ?? [];
      samples.push({ passed: result.passed, durationMs: result.durationMs });
      cases.set(key, samples);
    }
  }
  if (identities.size !== 1) throw new Error('Compare one provider/model/workflow at a time');
  const results = [...cases.values()].flat();
  const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
  const successRate = results.filter((result) => result.passed).length / results.length;
  const p95Ms = durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0;
  const reasons: string[] = [];
  if (cases.size < gate.minCases) reasons.push(`Need at least ${gate.minCases} distinct cases`);
  for (const [name, samples] of cases) {
    if (samples.length < gate.minSamples) reasons.push(`${name}: need ${gate.minSamples} samples`);
    if (samples.filter((item) => item.passed).length / samples.length < gate.minSuccessRate)
      reasons.push(`${name}: success rate below gate`);
  }
  if (successRate < gate.minSuccessRate) reasons.push('Overall success rate below gate');
  if (p95Ms > gate.maxP95Ms) reasons.push('P95 latency above gate');
  return {
    passed: reasons.length === 0,
    cases: cases.size,
    samples: results.length,
    successRate,
    p95Ms,
    reasons,
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log(
      'Usage: pnpm eval:report REPORT.json [REPORT.json ...]\nGate environment: EVAL_MIN_CASES=5 EVAL_MIN_SAMPLES=3 EVAL_MIN_SUCCESS_RATE=0.9 EVAL_MAX_P95_MS=180000\nOnly model-run reports for one provider/model/workflow are accepted. Reports do not independently prove a real API call.',
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
  if (new Set(reports.map((report) => JSON.stringify(report))).size !== reports.length)
    throw new Error('Duplicate report contents');
  const result = assessReports(reports, {
    minCases: Number(process.env.EVAL_MIN_CASES ?? 5),
    minSamples: Number(process.env.EVAL_MIN_SAMPLES ?? 3),
    minSuccessRate: Number(process.env.EVAL_MIN_SUCCESS_RATE ?? 0.9),
    maxP95Ms: Number(process.env.EVAL_MAX_P95_MS ?? 180000),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Invalid report');
    process.exitCode = 2;
  });
