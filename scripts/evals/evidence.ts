import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task } from '../../packages/agent-core/src/index';

export type Validity = 'valid' | 'invalid';
export interface Classification {
  validity: Validity;
  failureKind?: 'agent' | 'environment' | 'provider' | 'harness' | 'verifier';
  reason?: string;
}
export const invalid = (
  failureKind: Exclude<Classification['failureKind'], 'agent' | undefined>,
  reason: string,
): Classification => ({ validity: 'invalid', failureKind, reason });
export function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => [key, canonical(value)]),
          )
        : item;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/** Structured graders print a single HIKARI_EVAL_RESULT JSON line. No exit code alone proves a defect. */
export function classifyGrader(
  result: { exitCode: number; output: string },
  expected?: { exitCode: number; outputIncludes: string[] },
  context?: { baselineValidated: boolean; agentChanged: boolean },
): Classification & { passed: boolean } {
  const records = result.output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('HIKARI_EVAL_RESULT '));
  if (records.length) {
    try {
      if (records.length !== 1) throw new Error('Multiple grader results');
      const value: unknown = JSON.parse(records[0]!.slice('HIKARI_EVAL_RESULT '.length));
      if (
        !value ||
        typeof value !== 'object' ||
        !('status' in value) ||
        !['pass', 'fail', 'invalid'].includes(String(value.status))
      )
        throw new Error('Invalid grader status');
      if (value.status === 'invalid')
        return { ...invalid('verifier', 'Grader marked the run invalid'), passed: false };
      const passed = value.status === 'pass';
      if (passed !== (result.exitCode === 0))
        throw new Error('Grader status contradicts exit code');
      return { validity: 'valid', ...(passed ? {} : { failureKind: 'agent' as const }), passed };
    } catch {
      return {
        ...invalid('verifier', 'Malformed or contradictory structured grader result'),
        passed: false,
      };
    }
  }
  if (result.exitCode === 0) return { validity: 'valid', passed: true };
  if (
    expected &&
    result.exitCode === expected.exitCode &&
    expected.outputIncludes.every((text) => result.output.includes(text))
  )
    return { validity: 'valid', failureKind: 'agent', passed: false };
  if (expected)
    return {
      ...invalid('verifier', 'Baseline output does not match expectedBaseline'),
      passed: false,
    };
  // A healthy pre-agent baseline establishes the grader/dependency path. Subsequent
  // candidate-code parse/import/runtime errors after edits are failed repairs.
  if (
    context?.baselineValidated &&
    context.agentChanged &&
    /SyntaxError|ReferenceError|TypeError|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)/i.test(
      result.output,
    )
  )
    return { validity: 'valid', failureKind: 'agent', passed: false };
  if (
    /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|command not found|ENOENT|EACCES|EPERM|SyntaxError|sandbox.*(?:denied|failed)|Cannot find executable|Executable doesn't exist/i.test(
      result.output,
    )
  )
    return {
      ...invalid('environment', 'Grader dependency, syntax or execution failure'),
      passed: false,
    };
  if (/AssertionError|ERR_ASSERTION|Assertion failed|assertion failed/i.test(result.output))
    return { validity: 'valid', failureKind: 'agent', passed: false };
  return {
    ...invalid('verifier', 'Nonzero grader exit without an expected defect or assertion failure'),
    passed: false,
  };
}

/** Budget/step exhaustion and wrong tool use are agent outcomes. Unknown runtime failures are unscored. */
export function classifyTask(task: Task): Classification {
  const infrastructure = task.events.find(
    (event) =>
      event.type === 'tool.failed' &&
      ((event.data.metadata &&
        typeof event.data.metadata === 'object' &&
        'errorCode' in event.data.metadata &&
        event.data.metadata.errorCode === 'SANDBOX_UNAVAILABLE') ||
        /Executable doesn't exist|browserType\.launch|sandbox-exec:.*(?:sandbox_apply|failed|operation not permitted)|Install bubblewrap to use the OS sandbox|macOS sandbox-exec is unavailable|This OS has no supported sandbox|spawn .* (?:ENOENT|EACCES)/i.test(
          String(event.data.output ?? event.data.error),
        )),
  );
  if (infrastructure) return invalid('environment', 'Tool infrastructure unavailable');
  const stop = task.runSummary?.stopReason;
  if (
    stop &&
    [
      'STEP_LIMIT',
      'TOKEN_BUDGET',
      'COST_BUDGET',
      'TIME_BUDGET',
      'MODEL_LENGTH',
      'INVALID_TOOL_CALL',
      'ACCEPTANCE_FAILED',
      'REPEATED_TOOL_FAILURE',
      'GOAL_CONTINUATION_LIMIT',
      'GOAL_BLOCKED',
      'REVIEW_EVIDENCE',
      'WORKFLOW_TRANSITION',
      'WORKFLOW_HANDOFF_BATCH',
      'WORKFLOW_TOOL_DENIED',
      'PLAN_MODE_DENIED',
      'TOOL_BATCH_LIMIT',
      'INVALID_TOOL_INPUT',
      'UNKNOWN_TOOL',
      'SKILL_TOOL_DENIED',
    ].includes(stop)
  )
    return { validity: 'valid', failureKind: 'agent', reason: stop };
  if (stop && !['CANCELLED', 'INTERRUPTED'].includes(stop))
    return invalid(
      /PROVIDER|STREAM|ENDPOINT|API_KEY|MODEL_(?:DISCOVERY|AUTH|RATE_LIMIT|REQUEST|OUTPUT_LIMIT)/.test(
        stop,
      )
        ? 'provider'
        : 'harness',
      stop,
    );
  return {
    validity: 'valid',
    ...(task.status === 'failed' ? { failureKind: 'agent' as const } : {}),
  };
}

export interface EvidenceResult extends Classification {
  case: string;
  name?: string;
  passed: boolean;
  durationMs: number;
}
export function summarize(results: EvidenceResult[]) {
  const valid = results.filter((result) => result.validity === 'valid');
  const durations = valid.map((result) => result.durationMs).sort((a, b) => a - b);
  return {
    passed:
      valid.length > 0 && results.every((result) => result.validity === 'valid' && result.passed),
    samples: valid.length,
    invalidSamples: results.length - valid.length,
    successRate: valid.length ? valid.filter((result) => result.passed).length / valid.length : 0,
    durationMs: results.reduce((total, result) => total + result.durationMs, 0),
    latency: {
      p50Ms: durations[Math.max(0, Math.ceil(durations.length * 0.5) - 1)] ?? 0,
      p95Ms: durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0,
    },
  };
}

export async function harnessFingerprint(root: string): Promise<string> {
  const sources: Record<string, string> = {};
  // Content identity, not mutable Git state or local absolute workspace paths.
  async function collect(directory: string) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(name);
      else if (/\.(?:ts|json)$/.test(name))
        sources[name] = createHash('sha256')
          .update(await readFile(path.join(root, name)))
          .digest('hex');
    }
  }
  for (const directory of [
    'scripts/evals',
    'packages/agent-core/src',
    'packages/agent-runtime/src',
    'packages/agent-host/src',
    'packages/model-provider/src',
    'packages/sandbox/src',
    'packages/tools/src',
    'packages/skills/src',
    'packages/git/src',
    'packages/shared/src',
    'packages/mcp/src',
  ]) {
    await collect(directory);
    if (directory.startsWith('packages/')) {
      const manifest = `${path.posix.dirname(directory)}/package.json`;
      sources[manifest] = createHash('sha256')
        .update(await readFile(path.join(root, manifest)))
        .digest('hex');
    }
  }
  for (const file of ['package.json', 'tsconfig.json', 'pnpm-workspace.yaml'])
    sources[file] = createHash('sha256')
      .update(await readFile(path.join(root, file)))
      .digest('hex');
  return fingerprint(sources);
}

export async function evidenceEnvelope(options: {
  suite: string;
  evidence: 'model-run' | 'baseline-only' | 'grader-validation';
  workflow?: string;
  config?: {
    provider: string;
    model: string;
    baseUrl?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    streaming?: boolean;
    reasoningEffort?: string;
    inputPerMillion?: number;
    outputPerMillion?: number;
    cachedInputPerMillion?: number;
    cacheWriteInputPerMillion?: number;
  };
  limits: Record<string, unknown>;
  inputs: Record<string, unknown>;
  results: EvidenceResult[];
  artifacts?: string[];
}) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const harness = await harnessFingerprint(root);
  const config = options.config;
  let endpoint: string | undefined;
  if (config?.baseUrl) {
    const url = new URL(config.baseUrl);
    endpoint = url.origin + url.pathname;
  }
  const configuration = config
    ? {
        provider: config.provider,
        model: config.model,
        endpoint,
        contextWindow: config.contextWindow,
        maxOutputTokens: config.maxOutputTokens,
        streaming: config.streaming,
        reasoningEffort: config.reasoningEffort,
        inputPerMillion: config.inputPerMillion,
        outputPerMillion: config.outputPerMillion,
        cachedInputPerMillion: config.cachedInputPerMillion,
        cacheWriteInputPerMillion: config.cacheWriteInputPerMillion,
      }
    : undefined;
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    release: release(),
    processConfiguration: fingerprint({
      path: process.env.PATH,
      lang: process.env.LANG,
      locale: process.env.LC_ALL,
      timezone: process.env.TZ,
    }),
    dependencies: createHash('sha256')
      .update(await readFile(path.join(root, 'pnpm-lock.yaml')))
      .digest('hex'),
  };
  return {
    schemaVersion: 1,
    validity:
      options.results.length > 0 && options.results.every((result) => result.validity === 'valid')
        ? ('valid' as const)
        : ('invalid' as const),
    evidence: options.evidence,
    suite: options.suite,
    workflow: options.workflow ?? 'standard',
    provider: config?.provider,
    model: config?.model,
    createdAt: new Date().toISOString(),
    runtime: process.version,
    limits: options.limits,
    comparison: {
      configuration: fingerprint({
        configuration,
        workflow: options.workflow ?? 'standard',
        limits: options.limits,
        harness,
      }),
      environment: fingerprint(environment),
      inputs: Object.fromEntries(
        Object.entries(options.inputs).map(([name, value]) => [
          name,
          fingerprint({ value, harness }),
        ]),
      ),
    },
    environment,
    artifacts: options.artifacts ?? [],
    ...summarize(options.results),
    results: options.results.map((result) => ({ name: result.case, ...result })),
  };
}
