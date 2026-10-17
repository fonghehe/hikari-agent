import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repository = fileURLToPath(new URL('..', import.meta.url));
const loader = createRequire(import.meta.url).resolve('tsx');
async function run(entry: string, cwd: string, args: string[] = []) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('AGENT_') || key.startsWith('EVAL_') || key === 'CAPABILITY_CASES')
      delete env[key];
  const child = spawn(
    process.execPath,
    ['--import', loader, path.join(repository, 'scripts/evals', entry), ...args],
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
    expect(graders.stdout.match(/Oracle validated:/g)).toHaveLength(6);
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
      `AGENT_MODEL=explicit-capability-fixture\nAGENT_BASE_URL=http://127.0.0.1:${address.port}/v1\nAGENT_STREAMING=false\nAGENT_MAX_TOKENS=12000\nCAPABILITY_CASES=plan-is-read-only\n`,
    );
    const result = await run('capabilities.ts', root);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(calls).toBe(3);
    const directory = path.join(root, '.agent/evals');
    const [name] = await readdir(directory);
    const report = JSON.parse(await readFile(path.join(directory, name!, 'report.json'), 'utf8'));
    expect(report).toMatchObject({
      provider: 'compatible',
      limits: { maxTokens: 12000 },
      results: [{ name: 'plan-is-read-only', passed: true }],
    });
    expect(report.results).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
