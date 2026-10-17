import { loadEnvFile } from 'node:process';
import { modelConfigSchema, providerCatalog } from '../../packages/shared/src';
import { runOptionsSchema } from '../../packages/agent-core/src';
import { resolvedModelConfig } from '../../packages/model-provider/src';

type Suite = 'agent' | 'capabilities' | 'repository';
type Environment = Record<string, string | undefined>;

export function evaluationHelp(suite: Suite, names: readonly string[]) {
  return `Usage: pnpm eval:${suite} [--help] [--list]${suite !== 'capabilities' ? ' [--validate]' : ''}

Real runs read .env in the current directory; exported variables take precedence.
Desktop model profiles are separate and are not loaded by these commands.
Required: AGENT_MODEL, and AGENT_BASE_URL for compatible/Azure providers.
AGENT_PROVIDER defaults to compatible. Hosted presets also require AGENT_API_KEY.
Example .env (use your own model ID and key):
  AGENT_PROVIDER=deepseek
  AGENT_MODEL=your-model-id
  AGENT_API_KEY=your-key
${suite !== 'capabilities' ? 'EVAL_CASES' : 'CAPABILITY_CASES'} selects comma-separated cases; omit it to run all.
${suite !== 'capabilities' ? `EVAL_SAMPLES=1..10 (default 1). --validate ${suite === 'repository' ? 'reproduces a failing baseline' : 'checks fixed graders'} without a model.\n` : ''}AGENT_MAX_TOKENS defaults to 100000 per task. Real runs use model tokens.
Cases: ${names.join(', ')}
${suite === 'repository' ? 'EVAL_REPOSITORY_SUITE points to a local JSON suite with pinned repository commits.\n' : ''}Reports: .agent/evals/
See docs/zh/cli.md or docs/cli.md for full instructions.`;
}

export function loadEvaluationEnv(filename = '.env') {
  try {
    loadEnvFile(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Cannot read the evaluation .env file. Check its path and permissions.');
  }
}

export function evaluationSettings(
  suite: Suite,
  names: readonly string[],
  args: string[],
  env: Environment,
) {
  const allowed = ['--help', '-h', '--list', ...(suite !== 'capabilities' ? ['--validate'] : [])];
  if (args.some((arg) => !allowed.includes(arg)))
    throw new Error(`Unknown option. Run pnpm eval:${suite} --help for supported options.`);
  if (args.includes('--help') || args.includes('-h')) return { mode: 'help' as const };
  if (args.includes('--list')) return { mode: 'list' as const };
  const selector = suite !== 'capabilities' ? 'EVAL_CASES' : 'CAPABILITY_CASES';
  const selected =
    env[selector] === undefined
      ? [...names]
      : [...new Set(env[selector]!.split(',').map((name) => name.trim()))];
  if (!selected.length || selected.some((name) => !names.includes(name)))
    throw new Error(
      `${selector} must contain known, nonempty case names. Run pnpm eval:${suite} --list.`,
    );
  if (args.includes('--validate')) return { mode: 'validate' as const, selected };

  if (!env.AGENT_MODEL?.trim())
    throw new Error(
      'Missing AGENT_MODEL. Configure .env or export the model settings; desktop settings are not inherited.',
    );
  if (env.AGENT_PROVIDER === 'demo')
    throw new Error('Real evaluations do not accept the demo provider.');
  const number = (name: string) => (env[name] === undefined ? undefined : Number(env[name]));
  const boolean = (name: string) => {
    if (env[name] === undefined) return undefined;
    if (!['true', 'false'].includes(env[name]!)) throw new Error(`${name} must be true or false.`);
    return env[name] === 'true';
  };
  const parsed = modelConfigSchema.safeParse({
    provider: env.AGENT_PROVIDER ?? 'compatible',
    model: env.AGENT_MODEL,
    apiKey: env.AGENT_API_KEY ?? '',
    baseUrl: env.AGENT_BASE_URL || undefined,
    contextWindow: number('AGENT_CONTEXT_WINDOW'),
    maxOutputTokens: number('AGENT_MAX_OUTPUT_TOKENS'),
    inputPerMillion: number('AGENT_INPUT_PRICE'),
    outputPerMillion: number('AGENT_OUTPUT_PRICE'),
    streaming: boolean('AGENT_STREAMING'),
    reasoningEffort: env.AGENT_REASONING_EFFORT,
  });
  if (!parsed.success)
    throw new Error(
      `Invalid model settings: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}. Check the AGENT_* values.`,
    );
  const preset = providerCatalog[parsed.data.provider];
  if (!(parsed.data.baseUrl || preset.baseUrl))
    throw new Error('Missing AGENT_BASE_URL for the selected provider.');
  if (preset.keyRequired && !parsed.data.apiKey.trim())
    throw new Error('Missing AGENT_API_KEY for the selected provider.');
  if ((parsed.data.maxOutputTokens ?? 4096) >= (parsed.data.contextWindow ?? 64000))
    throw new Error('AGENT_MAX_OUTPUT_TOKENS must be smaller than AGENT_CONTEXT_WINDOW.');
  const config = resolvedModelConfig(parsed.data);
  const samples = suite !== 'capabilities' ? Number(env.EVAL_SAMPLES ?? 1) : 1;
  if (!Number.isInteger(samples) || samples < 1 || samples > 10)
    throw new Error('EVAL_SAMPLES must be between 1 and 10.');
  const workflow = runOptionsSchema.shape.workflow.safeParse(env.AGENT_WORKFLOW);
  const budget = runOptionsSchema.shape.maxTokens.safeParse(Number(env.AGENT_MAX_TOKENS ?? 100000));
  if (!workflow.success) throw new Error('AGENT_WORKFLOW must be standard or development.');
  if (!budget.success)
    throw new Error('AGENT_MAX_TOKENS is outside the supported token budget range.');
  if (
    suite === 'capabilities' &&
    config.streaming === false &&
    selected.includes('cancel-live-model-stream')
  )
    throw new Error(
      'cancel-live-model-stream requires AGENT_STREAMING=true; enable streaming or select other CAPABILITY_CASES.',
    );
  return {
    mode: 'run' as const,
    selected,
    config,
    samples,
    workflow: workflow.data,
    maxTokens: budget.data,
  };
}

export function prepareEvaluation(suite: Suite, names: readonly string[]) {
  try {
    const args = process.argv.slice(2);
    if (!args.some((arg) => ['--help', '-h', '--list'].includes(arg))) loadEvaluationEnv();
    const settings = evaluationSettings(suite, names, args, process.env);
    if (settings.mode === 'help') {
      console.log(evaluationHelp(suite, names));
      return;
    }
    if (settings.mode === 'list') {
      console.log(names.join('\n'));
      return;
    }
    return settings;
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : 'Invalid evaluation configuration.'}\nRun pnpm eval:${suite} --help for setup instructions.`,
    );
    process.exitCode = 2;
  }
}
