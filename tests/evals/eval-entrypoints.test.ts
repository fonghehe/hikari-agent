import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const loader = createRequire(import.meta.url).resolve('tsx');
async function run(entry: string, cwd: string, args: string[] = [], loaderPath = loader) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('AGENT_') || key.startsWith('EVAL_') || key === 'CAPABILITY_CASES')
      delete env[key];
  const child = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(loaderPath).href,
      path.join(repository, 'scripts/evals', entry),
      ...args,
    ],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

it('loads evaluation tooling from paths containing spaces and URL delimiters', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-eval-loader-'));
  try {
    const fixtureLoader = path.join(root, 'loader #100%.mjs');
    await writeFile(fixtureLoader, `import ${JSON.stringify(pathToFileURL(loader).href)};\n`);
    const help = await run('run.ts', root, ['--help'], fixtureLoader);
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain('Desktop model profiles are separate');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('both evaluation entrypoints provide help and actionable configuration failures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-eval-entry-'));
  try {
    for (const entry of ['run.ts', 'capabilities.ts']) {
      const help = await run(entry, root, ['--help']);
      expect(help.code, help.stderr).toBe(0);
      expect(help.stdout).toContain('Desktop model profiles are separate');
      const missing = await run(entry, root);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain('Missing AGENT_MODEL');
      expect(missing.stderr).not.toMatch(/at .*\.ts:\d|EPERM/);
    }
    const graders = await run('run.ts', root, ['--validate']);
    expect(graders.code, graders.stderr).toBe(0);
    expect(graders.stdout.match(/Oracle validated:/g)).toHaveLength(24);
    expect(graders.stdout).toContain('No agent/model evaluation was performed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it('capabilities loads .env, executes tools and writes the selected-case report', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-capability-entry-'));
  let calls = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as { messages: { role: string }[] };
    const observations = input.messages.filter((message) => message.role === 'tool');
    const step =
      observations.length === 0
        ? { name: 'read_file', args: { path: 'add.mjs' } }
        : observations.length === 1
          ? {
              name: 'update_plan',
              args: { steps: [{ id: 'fix', text: 'Fix add and verify', status: 'pending' }] },
            }
          : undefined;
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
                      id: `fixture-${calls}`,
                      type: 'function',
                      function: { name: step.name, arguments: JSON.stringify(step.args) },
                    },
                  ],
                }
              : { content: 'Inspected the file and prepared a read-only plan.' },
          },
        ],
      }),
    );
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    await writeFile(
      path.join(root, '.env'),
      `AGENT_MODEL=explicit-capability-fixture\nAGENT_BASE_URL=http://127.0.0.1:${address.port}/v1\nAGENT_STREAMING=false\nAGENT_MAX_TOKENS=32000\nCAPABILITY_CASES=plan-is-read-only\n`,
    );
    const result = await run('capabilities.ts', root);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(calls).toBe(3);
    const directory = path.join(root, '.agent/evals');
    const [name] = await readdir(directory);
    const report = JSON.parse(await readFile(path.join(directory, name!, 'report.json'), 'utf8'));
    expect(report).toMatchObject({
      schemaVersion: 1,
      evidence: 'model-run',
      suite: 'capabilities',
      workflow: 'standard',
      successRate: 1,
      samples: 1,
      invalidSamples: 0,
      provider: 'compatible',
      limits: { maxTokens: 32000 },
      results: [
        { name: 'plan-is-read-only', case: 'plan-is-read-only', validity: 'valid', passed: true },
      ],
    });
    expect(report.results).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it('agent repairs write the same versioned envelope using only the localhost model fixture', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-agent-entry-'));
  const source =
    'export function subtotal(items) { return items.reduce((total, item) => total + item.price, 0); }\n';
  const { createHash } = await import('node:crypto');
  const steps = [
    { name: 'read_file', input: { path: 'cart.mjs' } },
    {
      name: 'write_file',
      input: {
        path: 'cart.mjs',
        content:
          'export function subtotal(items) {return Math.round(items.reduce((n,x)=>n+Number(x.price)*x.quantity,0)*100)/100}',
        expectedHash: createHash('sha256').update(source).digest('hex'),
      },
    },
    {
      name: 'run_tests',
      input: {
        command: 'node',
        args: [
          '-e',
          "import('./cart.mjs').then(({subtotal})=>require('node:assert/strict').equal(subtotal([{price:'12.50',quantity:2}]),25))",
        ],
      },
    },
  ];
  let calls = 0;
  let unavailable = false;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    if (unavailable) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { message: 'fixture authentication unavailable' } }));
      return;
    }
    const step = steps[calls++];
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
                      id: `agent-${calls}`,
                      type: 'function',
                      function: { name: step.name, arguments: JSON.stringify(step.input) },
                    },
                  ],
                }
              : { content: 'Repaired and verified cart.' },
          },
        ],
      }),
    );
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    await writeFile(
      path.join(root, '.env'),
      `AGENT_MODEL=explicit-agent-fixture\nAGENT_BASE_URL=http://127.0.0.1:${address.port}/v1\nAGENT_STREAMING=false\nEVAL_CASES=cart-rounding\n`,
    );
    const result = await run('run.ts', root);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(calls).toBe(4);
    const filename = (await readdir(path.join(root, '.agent/evals'))).find((name) =>
      name.endsWith('.json'),
    );
    const report = JSON.parse(await readFile(path.join(root, '.agent/evals', filename!), 'utf8'));
    expect(report).toMatchObject({
      schemaVersion: 1,
      suite: 'agent',
      evidence: 'model-run',
      workflow: 'standard',
      samples: 1,
      successRate: 1,
      invalidSamples: 0,
      passed: true,
      results: [{ case: 'cart-rounding', name: 'cart-rounding', validity: 'valid', passed: true }],
    });
    expect(report.comparison.inputs['cart-rounding']).toMatch(/^[a-f0-9]{64}$/);
    expect(report.artifacts).toHaveLength(1);
    unavailable = true;
    const rejected = await run('run.ts', root);
    expect(rejected.code, rejected.stdout + rejected.stderr).toBe(1);
    const reports = await Promise.all(
      (await readdir(path.join(root, '.agent/evals')))
        .filter((name) => name.endsWith('.json'))
        .map(async (name) =>
          JSON.parse(await readFile(path.join(root, '.agent/evals', name), 'utf8')),
        ),
    );
    expect(reports.find((value) => value.invalidSamples === 1)).toMatchObject({
      passed: false,
      validity: 'invalid',
      successRate: 0,
      samples: 0,
      results: [{ validity: 'invalid', failureKind: 'provider', passed: false }],
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
