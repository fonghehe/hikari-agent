import { expect, it } from 'vitest';
import { mkdtemp, realpath, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GitService } from '../packages/git/src';
import { repositorySuiteSchema } from '../packages/agent-host/src/evaluation';

const entry = path.resolve('scripts/evals/repository.ts');
const loader = path.resolve('node_modules/tsx/dist/loader.mjs');
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
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
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

it('evaluates a pinned clone with an independent grader and leaves the source checkout untouched', async () => {
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
  let tamper = false;
  let phaseCalls = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    const steps = [
      { name: 'read_file', input: { path: 'sum.mjs' } },
      {
        name: 'write_file',
        input: {
          path: 'sum.mjs',
          content: fixed,
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
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    await writeFile(
      path.join(root, 'suite.json'),
      JSON.stringify({ cases: [{ ...specification, repository: '.', commit }] }),
    );
    await writeFile(
      path.join(root, '.env'),
      `EVAL_REPOSITORY_SUITE=suite.json\nAGENT_MODEL=explicit-fixture\nAGENT_BASE_URL=http://127.0.0.1:${address.port}/v1\nAGENT_STREAMING=false\n`,
    );
    const validated = await run(root, ['--validate']);
    expect(validated.code, validated.output).toBe(0);
    expect(validated.output).toContain('No model ran');
    expect(calls).toBe(0);
    const executed = await run(root, []);
    expect(executed.code, executed.output).toBe(0);
    expect(calls).toBe(4);
    expect(await readFile(path.join(root, 'sum.mjs'), 'utf8')).toBe(before);
    expect((await git.run(['rev-parse', 'HEAD'])).trim()).toBe(commit);
    const reports = await Promise.all(
      (await readdir(path.join(root, '.agent/evals'))).map(async (name) =>
        JSON.parse(await readFile(path.join(root, '.agent/evals', name, 'report.json'), 'utf8')),
      ),
    );
    expect(reports.find((report) => report.evidence === 'model-run')).toMatchObject({
      successRate: 1,
      results: [
        {
          passed: true,
          commit,
          baselineExit: 1,
          graderExit: 0,
          modified: ['sum.mjs'],
          preservedPassed: true,
          outsideAllowed: [],
        },
      ],
    });
    expect(reports.find((report) => report.evidence === 'baseline-only').model).toBeUndefined();
    // A passing test command cannot hide edits to the protected acceptance files.
    tamper = true;
    phaseCalls = 0;
    const tampered = await run(root, []);
    expect(tampered.code, tampered.output).toBe(1);
    const allReports = await Promise.all(
      (await readdir(path.join(root, '.agent/evals'))).map(async (name) =>
        JSON.parse(await readFile(path.join(root, '.agent/evals', name, 'report.json'), 'utf8')),
      ),
    );
    expect(allReports.find((report) => report.successRate === 0)).toMatchObject({
      results: [
        { passed: false, graderExit: 0, preservedPassed: false, outsideAllowed: ['tests.mjs'] },
      ],
    });
    expect(await readFile(path.join(root, 'tests.mjs'), 'utf8')).toBe(testSource);
    await writeFile(
      path.join(root, 'suite.json'),
      JSON.stringify({
        cases: [
          {
            ...specification,
            repository: '.',
            commit,
            grader: { command: 'node', args: ['-e', 'process.exit(0)'] },
          },
        ],
      }),
    );
    const greenBaseline = await run(root, ['--validate']);
    expect(greenBaseline.code, greenBaseline.output).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 25000);
