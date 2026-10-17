import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluationSettings, loadEvaluationEnv } from '../scripts/evals/config';

const names = ['plan-is-read-only', 'cancel-live-model-stream'];
const configured = { AGENT_MODEL: 'fixture', AGENT_BASE_URL: 'http://127.0.0.1:1234/v1' };
afterEach(() => vi.unstubAllEnvs());

describe('evaluation configuration', () => {
  it('allows help, listing and grader validation without any model credentials', () => {
    expect(evaluationSettings('agent', ['cart-rounding'], ['--help'], {})).toEqual({
      mode: 'help',
    });
    expect(evaluationSettings('capabilities', names, ['--list'], {})).toEqual({ mode: 'list' });
    expect(evaluationSettings('agent', ['cart-rounding'], ['--validate'], {})).toEqual({
      mode: 'validate',
      selected: ['cart-rounding'],
    });
    expect(() => evaluationSettings('capabilities', names, ['--validate'], {})).toThrow(
      'Unknown option',
    );
  });

  it('gives actionable errors for missing model settings and rejects demo runs', () => {
    expect(() => evaluationSettings('agent', names, [], {})).toThrow('Missing AGENT_MODEL');
    expect(() => evaluationSettings('capabilities', names, [], { AGENT_MODEL: 'fixture' })).toThrow(
      'Missing AGENT_BASE_URL',
    );
    expect(() =>
      evaluationSettings('agent', names, [], {
        AGENT_MODEL: 'fixture',
        AGENT_PROVIDER: 'deepseek',
      }),
    ).toThrow('Missing AGENT_API_KEY');
    expect(() =>
      evaluationSettings('agent', names, [], { ...configured, AGENT_PROVIDER: 'demo' }),
    ).toThrow('demo');
  });

  it('uses the same compatible default and configured limits in both suites', () => {
    for (const suite of ['agent', 'capabilities'] as const) {
      const settings = evaluationSettings(suite, names, [], {
        ...configured,
        AGENT_MAX_TOKENS: '12000',
        AGENT_MAX_OUTPUT_TOKENS: '1024',
        AGENT_CONTEXT_WINDOW: '16000',
      });
      expect(settings).toMatchObject({
        mode: 'run',
        maxTokens: 12000,
        config: {
          provider: 'compatible',
          maxOutputTokens: 1024,
          contextWindow: 16000,
        },
      });
    }
  });

  it('rejects empty and unknown selections rather than producing an empty success report', () => {
    for (const selection of ['', 'unknown', 'plan-is-read-only,'])
      expect(() =>
        evaluationSettings('capabilities', names, [], {
          ...configured,
          CAPABILITY_CASES: selection,
        }),
      ).toThrow('nonempty');
    expect(
      evaluationSettings('capabilities', names, [], {
        ...configured,
        CAPABILITY_CASES: 'plan-is-read-only, plan-is-read-only',
      }),
    ).toMatchObject({ selected: ['plan-is-read-only'] });
  });

  it('rejects invalid budgets and incompatible streaming before contacting a model', () => {
    for (const env of [
      { EVAL_SAMPLES: '0' },
      { AGENT_MAX_TOKENS: 'bad' },
      { AGENT_MAX_OUTPUT_TOKENS: '16000', AGENT_CONTEXT_WINDOW: '8192' },
    ])
      expect(() => evaluationSettings('agent', names, [], { ...configured, ...env })).toThrow();
    expect(() =>
      evaluationSettings('capabilities', names, [], { ...configured, AGENT_STREAMING: 'false' }),
    ).toThrow('requires AGENT_STREAMING=true');
  });

  it('loads a local env file while preserving exported variables', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hikari-eval-config-'));
    vi.stubEnv('HIKARI_EVAL_PRECEDENCE', 'exported');
    vi.stubEnv('HIKARI_EVAL_FROM_FILE', undefined);
    try {
      const filename = path.join(directory, '.env');
      await writeFile(filename, 'HIKARI_EVAL_PRECEDENCE=file\nHIKARI_EVAL_FROM_FILE="loaded"\n');
      loadEvaluationEnv(filename);
      expect(process.env.HIKARI_EVAL_PRECEDENCE).toBe('exported');
      expect(process.env.HIKARI_EVAL_FROM_FILE).toBe('loaded');
      expect(() => loadEvaluationEnv(path.join(directory, 'missing'))).not.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
