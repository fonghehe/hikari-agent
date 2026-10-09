import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repository = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'forge-cli-'));
let child;
let requests = 0;
const server = createServer(async (req, res) => {
  try {
    requests++;
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const request = JSON.parse(body);
    assert(
      !request.tools.some((tool) =>
        ['write_file', 'shell', 'connect_mcp'].includes(tool.function.name),
      ),
    );
    const observation = request.messages.find((message) => message.role === 'tool');
    const message = observation
      ? {
          content: observation.content.includes('CLI fixture content')
            ? 'CLI read verified'
            : 'Wrong observation',
        }
      : {
          content: '',
          tool_calls: [
            {
              id: 'read-cli',
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt' }) },
            },
          ],
        };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }] }));
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});
try {
  await writeFile(path.join(root, 'fixture.txt'), 'CLI fixture content');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  child = spawn(
    process.execPath,
    [
      path.join(repository, 'node_modules/tsx/dist/cli.mjs'),
      'apps/cli/src/index.ts',
      'run',
      'Inspect fixture',
    ],
    {
      cwd: repository,
      env: {
        ...process.env,
        AGENT_MODEL: 'explicit-cli-fixture',
        AGENT_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        AGENT_API_KEY: '',
        AGENT_WORKSPACE: root,
        AGENT_MODE: 'plan',
        AGENT_MAX_STEPS: '5',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  }).finally(() => clearTimeout(timeout));
  assert.equal(code, 0, errors);
  const events = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(
    events.some(
      (event) => event.type === 'agent.completed' && event.data.text === 'CLI read verified',
    ),
  );
  assert(
    events.some(
      (event) =>
        event.type === 'agent.run.summary' &&
        event.data.modelSteps === 2 &&
        event.data.tests.length === 0,
    ),
  );
  console.log(
    'PASS: standalone CLI Plan mode, real file tool, bounded loop and execution evidence.',
  );
  const previousRequests = requests;
  child = spawn(
    process.execPath,
    [
      path.join(repository, 'node_modules/tsx/dist/cli.mjs'),
      'apps/cli/src/index.ts',
      'run',
      '修复示例测试',
    ],
    {
      cwd: repository,
      env: {
        ...process.env,
        AGENT_PROVIDER: 'demo',
        AGENT_MODEL: '',
        AGENT_WORKSPACE: '/nonexistent/demo-workspace',
        AGENT_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        AGENT_MODE: 'execute',
        AGENT_MAX_STEPS: '8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let demoOutput = '';
  let demoErrors = '';
  child.stdout.on('data', (chunk) => {
    demoOutput += chunk;
  });
  child.stderr.on('data', (chunk) => {
    demoErrors += chunk;
  });
  const demoTimeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  const demoCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  }).finally(() => clearTimeout(demoTimeout));
  assert.equal(demoCode, 0, demoErrors);
  const demoEvents = demoOutput
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(
    demoEvents.some(
      (event) => event.type === 'agent.completed' && event.data.text.includes('模拟回答'),
    ),
  );
  assert(
    demoEvents.some(
      (event) =>
        event.type === 'agent.run.summary' &&
        event.data.tests.length === 0 &&
        event.data.filesChanged.includes('src/cart.ts'),
    ),
  );
  assert.equal(requests, previousRequests, 'Demo must not contact a model endpoint');
  assert.equal(await readFile(path.join(root, 'fixture.txt'), 'utf8'), 'CLI fixture content');
  console.log(
    'PASS: offline CLI demo, no model/workspace required, simulated changes and no fake test evidence.',
  );
} finally {
  child?.kill();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
