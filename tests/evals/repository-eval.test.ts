import { describe, expect, it } from 'vitest';
import { mkdtemp, realpath, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { GitService } from '../../packages/git/src/index';
import { repositorySuiteSchema } from '../../packages/agent-host/src/evaluation';

const entry = path.resolve('scripts/evals/repository.ts');
const loader = pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;
async function run(root: string, args: string[]) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(AGENT_|EVAL_)/.test(name)) delete env[name];
  const child = spawn(process.execPath, ['--import', loader, entry, ...args], { cwd: root, env });
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 15000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (timedOut) throw new Error(`Repository evaluation exceeded 15000ms:\n${output}`);
    return { code, output };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
const specification = {
  name: 'repair',
  repository: './source',
  commit: 'a'.repeat(40),
  prompt: 'Repair sum and test it',
  grader: { command: 'node', args: ['tests.mjs'] },
  allowedPaths: ['sum.mjs'],
  preservePaths: ['tests.mjs'],
};
it('requires immutable commits, bounded paths and separate preserved tests', () => {
  expect(repositorySuiteSchema.safeParse({ cases: [specification] }).success).toBe(true);
  for (const change of [
    { commit: 'main' },
    { allowedPaths: ['../outside'] },
    { allowedPaths: ['.agent/state/x'] },
    { allowedPaths: ['tests.mjs'] },
  ]) {
    expect(
      repositorySuiteSchema.safeParse({ cases: [{ ...specification, ...change }] }).success,
    ).toBe(false);
  }
});

async function createFixture(options: { tamper?: boolean; candidate?: string } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-project-eval-')));
  const git = new GitService(root);
  const before = 'export function sum(values) { return 0; }\n';
  const fixed = 'export function sum(values) { return values.reduce((a,b)=>a+b,0); }\n';
  await writeFile(path.join(root, 'sum.mjs'), before);
  const testSource =
    "import assert from 'node:assert/strict';import {sum} from './sum.mjs';assert.equal(sum([2,3]),5);assert.equal(sum([]),0);\n";
  await writeFile(path.join(root, 'tests.mjs'), testSource);
  await git.run(['init', '--quiet']);
  await git.run(['add', 'sum.mjs', 'tests.mjs']);
  await git.run([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'broken baseline',
  ]);
  const commit = (await git.run(['rev-parse', 'HEAD'])).trim();
  let calls = 0;
  const tamper = options.tamper ?? false;
  const brokenEdit = options.candidate;
  let phaseCalls = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    const steps = [
      { name: 'read_file', input: { path: 'sum.mjs' } },
      {
        name: 'write_file',
        input: {
          path: 'sum.mjs',
          content: brokenEdit ?? fixed,
          expectedHash: createHash('sha256').update(before).digest('hex'),
        },
      },
      ...(tamper
        ? [
            {
              name: 'write_file',
              input: {
                path: 'tests.mjs',
                content: 'console.log("bypassed");',
                expectedHash: createHash('sha256').update(testSource).digest('hex'),
              },
            },
          ]
        : []),
      { name: 'run_tests', input: { command: 'node', args: ['tests.mjs'] } },
    ];
    const step = steps[phaseCalls++];
    calls++;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        choices: [
          {
            message: step
              ? {
                  content: '',
                  tool_calls: [
                    {
                      id: `step-${calls}`,
                      type: 'function',
                      function: {
                        name: step.name,
                        arguments: JSON.stringify(step.input),
                      },
                    },
                  ],
                }
              : { content: 'Repaired and verified sum.' },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 20 },
      }),
    );
  });
  const close = async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const writeSuite = (definition: Record<string, unknown> = {}) =>
      writeFile(
        path.join(root, 'suite.json'),
        JSON.stringify({ cases: [{ ...specification, repository: '.', commit, ...definition }] }),
      );
    await writeSuite();
    await writeFile(
      path.join(root, '.env'),
      `EVAL_REPOSITORY_SUITE=suite.json\nAGENT_MODEL=explicit-fixture\nAGENT_BASE_URL=http://127.0.0.1:${address.port}/v1\nAGENT_STREAMING=false\n`,
    );

    return {
      root,
      git,
      commit,
      before,
      testSource,
      writeSuite,
      close,
      calls: () => calls,
      reports: async () =>
        Promise.all(
          (await readdir(path.join(root, '.agent/evals'))).map(async (name) =>
            JSON.parse(
              await readFile(path.join(root, '.agent/evals', name, 'report.json'), 'utf8'),
            ),
          ),
        ),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function withFixture(
  check: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  options: { tamper?: boolean; candidate?: string } = {},
) {
  const fixture = await createFixture(options);
  try {
    await check(fixture);
  } finally {
    await fixture.close();
  }
}

// Keep each CLI invocation independently bounded. Combining all twelve runs in
// one 25-second test made ordinary CI contention look like an evaluation failure.
// Restricted execution needs a Linux Docker engine/image on Windows, which the
// hosted Windows runner does not provision.
describe.skipIf(process.platform === 'win32')('repository evaluation', () => {
  it('validates the pinned baseline without running a model', async () => {
    await withFixture(async (fixture) => {
      const validated = await run(fixture.root, ['--validate']);
      expect(validated.code, validated.output).toBe(0);
      expect(validated.output).toContain('No model ran');
      expect(fixture.calls()).toBe(0);
      const reports = await fixture.reports();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ evidence: 'baseline-only', passed: true });
      expect(reports[0].model).toBeUndefined();
    });
  }, 25000);

  it('repairs a pinned clone and leaves the source checkout untouched', async () => {
    await withFixture(async (fixture) => {
      const executed = await run(fixture.root, []);
      expect(executed.code, executed.output).toBe(0);
      expect(fixture.calls()).toBe(4);
      expect(await readFile(path.join(fixture.root, 'sum.mjs'), 'utf8')).toBe(fixture.before);
      expect((await fixture.git.run(['rev-parse', 'HEAD'])).trim()).toBe(fixture.commit);
      const reports = await fixture.reports();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        schemaVersion: 1,
        evidence: 'model-run',
        suite: 'repository',
        workflow: 'standard',
        samples: 1,
        invalidSamples: 0,
        successRate: 1,
        results: [
          {
            passed: true,
            validity: 'valid',
            case: 'repair',
            name: 'repair',
            commit: fixture.commit,
            baselineExit: 1,
            graderExit: 0,
            modified: ['sum.mjs'],
            preservedPassed: true,
            outsideAllowed: [],
          },
        ],
      });
    });
  }, 25000);

  it('rejects protected test edits even when the candidate grader passes', async () => {
    await withFixture(
      async (fixture) => {
        const tampered = await run(fixture.root, []);
        expect(tampered.code, tampered.output).toBe(1);
        expect((await fixture.reports())[0]).toMatchObject({
          successRate: 0,
          results: [
            { passed: false, graderExit: 0, preservedPassed: false, outsideAllowed: ['tests.mjs'] },
          ],
        });
        expect(await readFile(path.join(fixture.root, 'tests.mjs'), 'utf8')).toBe(
          fixture.testSource,
        );
      },
      { tamper: true },
    );
  }, 25000);

  it.each([
    {
      name: 'missing candidate dependency',
      candidate: "import 'missing-agent-dependency';",
      error: 'missing-agent-dependency',
    },
    { name: 'candidate syntax error', candidate: 'function {', error: 'SyntaxError' },
  ])(
    'classifies $name as an agent failure after a valid baseline',
    async ({ candidate, error }) => {
      await withFixture(
        async (fixture) => {
          const broken = await run(fixture.root, []);
          expect(broken.code, broken.output).toBe(1);
          expect((await fixture.reports())[0]).toMatchObject({
            samples: 1,
            invalidSamples: 0,
            successRate: 0,
            results: [
              {
                validity: 'valid',
                failureKind: 'agent',
                passed: false,
                status: 'failed',
                graderOutput: expect.stringContaining(error),
              },
            ],
          });
        },
        { candidate },
      );
    },
    25000,
  );

  const invalidBaselines: { name: string; definition: Record<string, unknown> }[] = [
    {
      name: 'passing baseline',
      definition: { grader: { command: 'node', args: ['-e', 'process.exit(0)'] } },
    },
    ...["import 'missing-eval-dependency';", 'function {', 'process.exit(1)'].map((source) => ({
      name: `invalid grader: ${source}`,
      definition: { grader: { command: 'node', args: ['-e', source] } },
    })),
    {
      name: 'failed setup',
      definition: { setup: [{ command: 'node', args: ['-e', 'process.exit(1)'] }] },
    },
  ];
  it.each(invalidBaselines)(
    'rejects $name without counting a model sample',
    async ({ definition }) => {
      await withFixture(async (fixture) => {
        await fixture.writeSuite(definition);
        const invalid = await run(fixture.root, ['--validate']);
        expect(invalid.code, invalid.output).toBe(1);
        expect(fixture.calls()).toBe(0);
        const reports = await fixture.reports();
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
          samples: 0,
          invalidSamples: 1,
          passed: false,
          results: [{ validity: 'invalid' }],
        });
      });
    },
    25000,
  );

  const declaredBaselines: { name: string; definition: Record<string, unknown> }[] = [
    {
      name: 'explicit exit code and defect output',
      definition: {
        grader: {
          command: 'node',
          args: ['-e', "console.error('specific defect');process.exit(2)"],
        },
        expectedBaseline: { exitCode: 2, outputIncludes: ['specific defect'] },
      },
    },
    {
      name: 'structured failing baseline',
      definition: {
        grader: {
          command: 'node',
          args: [
            '-e',
            "console.log('HIKARI_EVAL_RESULT '+JSON.stringify({status:'fail'}));process.exit(1)",
          ],
        },
      },
    },
  ];
  it.each(declaredBaselines)(
    'accepts $name without running a model',
    async ({ definition }) => {
      await withFixture(async (fixture) => {
        await fixture.writeSuite(definition);
        const valid = await run(fixture.root, ['--validate']);
        expect(valid.code, valid.output).toBe(0);
        expect(fixture.calls()).toBe(0);
        expect((await fixture.reports())[0]).toMatchObject({
          evidence: 'baseline-only',
          passed: true,
          invalidSamples: 0,
          results: [{ validity: 'valid', baselineExit: expect.any(Number) }],
        });
      });
    },
    25000,
  );
});
