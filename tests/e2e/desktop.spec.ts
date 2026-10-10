import { mkdtemp as tempDirectory, rm as removeDirectory } from 'node:fs/promises';
import { tmpdir as temporaryRoot } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { wideDesktopWindow } from './desktop-window';
let dataDirectory: string;
test.beforeEach(async () => {
  dataDirectory = await tempDirectory(path.join(temporaryRoot(), 'forge-desktop-data-'));
});
test.afterEach(async () => {
  await removeDirectory(dataDirectory, { recursive: true, force: true });
});
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
test('desktop starts with secure preload and empty workspace', async () => {
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: dataDirectory },
  });
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: /A little direction/ })).toBeVisible();
    expect(await window.evaluate(() => typeof globalThis.window.hikari?.workspace.open)).toBe(
      'function',
    );
    expect(
      await window.evaluate(() => typeof (globalThis as Record<string, unknown>).require),
    ).toBe('undefined');
    await window.screenshot({ path: 'test-results/desktop.png' });
  } finally {
    await app.close();
  }
});

test('real IPC runs tools and preserves follow-up context in the same worktree', async () => {
  const { createServer } = await import('node:http');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'forge-e2e-'));
  await writeFile(path.join(root, 'sample.txt'), 'fixture file content');
  const { runProcess, LogicalSandboxProvider } = await import('../../packages/sandbox/src');
  const options = {
    cwd: root,
    env: new LogicalSandboxProvider().environment(),
    signal: new AbortController().signal,
  };
  await runProcess('git', ['init'], options);
  await runProcess('git', ['add', 'sample.txt'], options);
  await runProcess(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'fixture',
    ],
    options,
  );
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const input = JSON.parse(body) as { messages: { role: string; content: string }[] };
    const observation = input.messages.find((m) => m.role === 'tool');
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message:
              input.messages.at(-1)?.content === 'Explain previous result'
                ? {
                    content: input.messages.some(
                      (m) => m.role === 'assistant' && m.content === 'Fixture read verified',
                    )
                      ? 'Follow-up context verified'
                      : 'Context missing',
                  }
                : observation
                  ? {
                      content: observation.content.includes('fixture file content')
                        ? 'Fixture read verified'
                        : 'Read verification failed',
                    }
                  : {
                      content: 'Reading the fixture',
                      tool_calls: [
                        {
                          id: 'read-fixture',
                          type: 'function',
                          function: {
                            name: 'read_file',
                            arguments: JSON.stringify({ path: 'sample.txt' }),
                          },
                        },
                      ],
                    },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server');
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: dataDirectory },
  });
  try {
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [selected],
      })) as typeof dialog.showOpenDialog;
    }, root);
    const page = await wideDesktopWindow(app);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.getByRole('treeitem', { name: 'sample.txt' })).toBeVisible();
    await page.getByRole('button', { name: 'Configure model', exact: true }).click();
    await page.getByLabel('Model', { exact: true }).fill('fixture-model');
    await page.getByLabel('Base URL').fill(`http://127.0.0.1:${address.port}/v1`);
    await page.locator('form').getByRole('button', { name: 'Connect model', exact: true }).click();
    await page.getByLabel('Isolate in a Git worktree').check();
    await page.getByRole('textbox', { name: 'Task prompt' }).fill('Read sample.txt');
    await page.getByRole('button', { name: 'Start task' }).click();
    await expect(
      page
        .locator('[data-event-type="agent.completed"]')
        .getByText('Fixture read verified', { exact: true }),
    ).toBeVisible({
      timeout: 15000,
    });
    await page
      .getByRole('textbox', { name: 'Follow-up prompt', exact: true })
      .fill('Explain previous result');
    await page.getByRole('button', { name: 'Send follow-up', exact: true }).click();
    await expect(
      page
        .locator('[data-event-type="agent.completed"]')
        .getByText('Follow-up context verified', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous turn', exact: true })).toBeVisible();
    const turns = await page.evaluate(() => globalThis.window.hikari!.agent.list());
    expect(turns).toHaveLength(2);
    expect(turns[1]!.parentTaskId).toBe(turns[0]!.id);
    await expect(page.getByRole('button', { name: '.git/index', exact: true })).toHaveCount(0);
    expect(turns[0]!.worktree).toBeTruthy();
    expect(turns[1]!.worktree).toBe(turns[0]!.worktree);
    await page.screenshot({ path: 'test-results/task-flow.png' });
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('agent fixes a failing test through approval, patch, retest, diff undo and persistence', async () => {
  const { createServer } = await import('node:http');
  const { writeFile, readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const root = await tempDirectory(path.join(temporaryRoot(), 'forge-repair-'));
  await writeFile(path.join(root, 'sample.txt'), 'one\n');
  const patch = '--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-one\n+two\n';
  const hash = createHash('sha256').update('one\n').digest('hex');
  const command = {
    command: process.execPath,
    args: [
      '-e',
      "const fs=require('node:fs');if(fs.readFileSync('sample.txt','utf8')!=='two\\n'){console.error('Expected two');process.exit(1)}console.log('Tests passed')",
    ],
  };
  const script = [
    { name: 'read_file', input: { path: 'sample.txt' } },
    { name: 'run_tests', input: command },
    {
      name: 'apply_patch',
      input: {
        diff: patch,
        files: [{ path: 'sample.txt', expectedHash: hash }],
        previewOnly: true,
      },
    },
    {
      name: 'apply_patch',
      input: {
        diff: patch,
        files: [{ path: 'sample.txt', expectedHash: hash }],
        previewOnly: false,
      },
    },
    { name: 'run_tests', input: command },
  ];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const input = JSON.parse(body) as { messages: { role: string; content: string }[] };
    const observations = input.messages.filter((message) => message.role === 'tool');
    const step = script[observations.length];
    const message = step
      ? {
          content: '',
          tool_calls: [
            {
              id: `step-${observations.length}`,
              type: 'function',
              function: { name: step.name, arguments: JSON.stringify(step.input) },
            },
          ],
        }
      : {
          content: observations.at(-1)?.content.includes('Tests passed')
            ? 'Repair verified with real tests'
            : 'Repair failed',
        };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  let app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: dataDirectory },
  });
  try {
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [selected],
      })) as typeof dialog.showOpenDialog;
    }, root);
    let page = await wideDesktopWindow(app);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await page.evaluate(
      async ({ url, execution }) => {
        await globalThis.window.hikari!.agent.configure({
          provider: 'compatible',
          model: 'repair-fixture',
          apiKey: '',
          baseUrl: url,
        });
        await globalThis.window.hikari!.agent.start('Fix the fixture test', false, undefined, {
          mode: 'execute',
          maxSteps: 30,
          execution,
        });
      },
      {
        url: `http://127.0.0.1:${address.port}/v1`,
        // Windows CI does not provision the Linux Docker image required for restricted execution.
        execution: process.platform === 'win32' ? ('host' as const) : ('restricted' as const),
      },
    );
    await page.getByRole('button', { name: /Fix the fixture test/ }).click();
    await page.getByRole('button', { name: 'Allow for session', exact: true }).click();
    await expect(
      page
        .locator('[data-event-type="agent.completed"]')
        .getByText('Repair verified with real tests', { exact: true }),
    ).toBeVisible({
      timeout: 15000,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
    ).toBe(true);
    await expect(page.locator('footer')).toBeInViewport();
    await expect(page.getByRole('region', { name: 'Execution evidence' })).toContainText(
      'Recorded checks passed',
    );
    expect(await readFile(path.join(root, 'sample.txt'), 'utf8')).toBe('two\n');
    const tasks = await page.evaluate(() => globalThis.window.hikari!.agent.list());
    const task = tasks.find((t) => t.prompt === 'Fix the fixture test')!;
    expect(task.runSummary?.tests.map((test) => test.status)).toEqual(['failed', 'passed']);
    expect(
      task.events.some((event) => event.type === 'tool.failed' && event.data.tool === 'run_tests'),
    ).toBe(true);
    await page.getByRole('button', { name: 'diff', exact: true }).click();
    await page.getByRole('button', { name: 'sample.txt', exact: true }).click();
    await expect(page.locator('.monaco-diff-editor')).toBeVisible();
    await page.screenshot({ path: 'test-results/repair-diff.png' });
    await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => readFile(path.join(root, 'sample.txt'), 'utf8')).toBe('one\n');
    await app.close();
    app = await electron.launch({
      executablePath: require('electron') as string,
      args: ['apps/desktop'],
      env: { ...process.env, HIKARI_DATA_DIR: dataDirectory },
    });
    page = await wideDesktopWindow(app);
    await expect(page.getByRole('button', { name: /Fix the fixture test/ })).toBeVisible();
    expect(
      (await page.evaluate(() => globalThis.window.hikari!.agent.list())).find(
        (t) => t.id === task.id,
      )?.status,
    ).toBe('completed');
    expect(
      (await page.evaluate(() => globalThis.window.hikari!.agent.list())).find(
        (turn) => turn.id === task.id,
      )?.runSummary?.tests[1]?.exitCode,
    ).toBe(0);
    expect(
      (await page.evaluate((id) => globalThis.window.hikari!.git.changes(id), task.id))[0]?.undone,
    ).toBe(true);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeDirectory(root, { recursive: true, force: true });
  }
});

test('Plan mode prevents writes, persists a plan and carries it into an explicit Execute turn', async () => {
  const { createServer } = await import('node:http');
  const { writeFile, readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const root = await tempDirectory(path.join(temporaryRoot(), 'forge-plan-'));
  await writeFile(path.join(root, 'sample.txt'), 'unchanged');
  const steps = [
    { name: 'read_file', input: { path: 'sample.txt' } },
    {
      name: 'write_file',
      input: {
        path: 'sample.txt',
        content: 'unsafe',
        expectedHash: createHash('sha256').update('unchanged').digest('hex'),
      },
    },
    {
      name: 'update_plan',
      input: {
        steps: [
          { id: 'inspect', text: 'Inspect the current file', status: 'completed' },
          { id: 'implement', text: 'Implement a focused change', status: 'pending' },
        ],
      },
    },
  ];
  let leaked = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const input = JSON.parse(body) as {
      messages: { role: string; content: string }[];
      tools: { function: { name: string } }[];
    };
    const execute = input.messages.at(-1)?.content.startsWith('Implement the plan');
    let message;
    if (execute) {
      const hasPlan = input.messages.some(
        (entry) =>
          entry.role === 'assistant' && entry.content.includes('Implement a focused change'),
      );
      message = {
        content:
          hasPlan && input.tools.some((tool) => tool.function.name === 'write_file')
            ? 'Plan carried into Execute'
            : 'Missing execution context',
      };
    } else {
      leaked ||= input.tools.some(
        (tool) => tool.function.name === 'write_file' || tool.function.name === 'shell',
      );
      const index = input.messages.filter((entry) => entry.role === 'tool').length;
      const step = steps[index];
      message = step
        ? {
            content: '',
            tool_calls: [
              {
                id: `plan-${index}`,
                type: 'function',
                function: { name: step.name, arguments: JSON.stringify(step.input) },
              },
            ],
          }
        : { content: 'Plan ready for review' };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing model fixture');
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: dataDirectory },
  });
  try {
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [selected],
      })) as typeof dialog.showOpenDialog;
    }, root);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Configure model', exact: true }).click();
    await page.getByLabel('Model', { exact: true }).fill('plan-fixture');
    await page.getByLabel('Base URL').fill(`http://127.0.0.1:${address.port}/v1`);
    await page.locator('form').getByRole('button', { name: 'Connect model', exact: true }).click();
    await page.getByLabel('Agent mode').selectOption('plan');
    await page.getByLabel('Maximum model turns').fill('8');
    await expect(page.getByLabel('Isolate in a Git worktree')).toBeDisabled();
    await page.getByRole('textbox', { name: 'Task prompt' }).fill('Inspect and plan');
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Task plan' })).toContainText(
      'Implement a focused change',
    );
    await expect(page.locator('[data-event-type="agent.completed"]')).toContainText(
      'Plan ready for review',
    );
    await expect(page.getByRole('region', { name: 'Execution evidence' })).toContainText(
      'No tests run',
    );
    expect(leaked).toBe(false);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf8')).toBe('unchanged');
    await page.screenshot({ path: 'test-results/plan-mode.png' });
    await page.getByRole('button', { name: 'Use plan in Execute', exact: true }).click();
    await expect(page.getByLabel('Agent mode')).toHaveValue('execute');
    await page.getByRole('button', { name: 'Send follow-up', exact: true }).click();
    await expect(page.locator('[data-event-type="agent.completed"]')).toContainText(
      'Plan carried into Execute',
    );
    const turns = await page.evaluate(() => globalThis.window.hikari!.agent.list());
    expect(turns[0]!.runOptions).toEqual({ mode: 'plan', maxSteps: 8 });
    expect(turns[0]!.plan?.steps).toHaveLength(2);
    expect(turns[0]!.runSummary?.toolFailures).toBe(1);
    expect(turns[1]!.runOptions?.mode).toBe('execute');
    await page.getByLabel('Search tasks').fill('Inspect and plan');
    await expect(page.locator('.task-button')).toHaveCount(1);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeDirectory(root, { recursive: true, force: true });
  }
});
