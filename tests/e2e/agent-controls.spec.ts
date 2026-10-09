import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
test('persists project memory and manages MCP secrets and skills through the desktop UI', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'hikari-extensions-e2e-'));
  const root = path.join(data, 'workspace');
  const skill = path.join(data, 'release-review');
  await mkdir(root);
  await mkdir(skill);
  await writeFile(path.join(root, 'notes.md'), '# Project');
  await writeFile(
    path.join(skill, 'SKILL.md'),
    '---\nname: release-review\ndescription: Review release requirements\n---\nInspect the release requirements.',
  );
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests++;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message:
              requests === 1
                ? {
                    content: '',
                    tool_calls: [
                      {
                        id: 'remember-1',
                        type: 'function',
                        function: {
                          name: 'remember',
                          arguments: JSON.stringify({
                            title: 'Release convention',
                            content: 'Run acceptance checks before publishing.',
                          }),
                        },
                      },
                    ],
                  }
                : { content: 'Saved the project decision.' },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing model port');
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, root);
    const window = await app.firstWindow();
    await window.getByRole('button', { name: 'Open workspace', exact: true }).click();
    const id = await window.evaluate(async (url) => {
      const api = globalThis.window.hikari!;
      await api.agent.configure({
        provider: 'compatible',
        model: 'protocol-fixture',
        apiKey: '',
        baseUrl: url,
      });
      return (
        await api.agent.start('Remember the release convention', false, undefined, {
          mode: 'execute',
          maxSteps: 5,
          requireTests: false,
        })
      ).id;
    }, `http://127.0.0.1:${address.port}/v1`);
    await expect
      .poll(() =>
        window.evaluate(
          async (id) =>
            (await globalThis.window.hikari!.agent.list()).find((task) => task.id === id)?.status,
          id,
        ),
      )
      .toBe('completed');
    await window.getByRole('button', { name: 'Memory & extensions', exact: true }).click();
    const dialog = window.getByRole('dialog', { name: 'Workspace settings' });
    await expect(dialog.getByText('Release convention', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Forget', exact: true }).click();
    await expect(dialog.getByText('No saved memory', { exact: true })).toBeVisible();
    await dialog.getByLabel('Server name', { exact: true }).fill('reference');
    await dialog.getByLabel('Server URL', { exact: true }).fill('https://example.invalid/mcp');
    await dialog
      .getByLabel('Authorization token (optional)', { exact: true })
      .fill('test-private-token');
    await dialog.getByRole('button', { name: 'Save server', exact: true }).click();
    await expect(dialog.getByText('reference', { exact: true })).toBeVisible();
    expect(await readFile(path.join(root, '.agent', 'mcp.json'), 'utf8')).not.toContain(
      'test-private-token',
    );
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(dialog.getByText('reference', { exact: true })).toHaveCount(0);
    await app.evaluate(({ dialog }, skill) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [skill] });
    }, skill);
    await dialog.getByRole('button', { name: 'Import skill folder', exact: true }).click();
    await expect(dialog.getByText('release-review', { exact: true })).toBeVisible();
    expect(
      await readFile(path.join(root, '.agent', 'skills', 'release-review', 'SKILL.md'), 'utf8'),
    ).toContain('Review release requirements');
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(dialog.getByText('release-review', { exact: true })).toHaveCount(0);
    await expect(window.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
test('asks for user input and rejects completion when file acceptance fails', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'hikari-input-e2e-'));
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests++;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        usage: { prompt_tokens: 50, completion_tokens: 12 },
        choices: [
          {
            message:
              requests === 1
                ? {
                    content: '',
                    tool_calls: [
                      {
                        id: 'ask-1',
                        type: 'function',
                        function: {
                          name: 'ask_user',
                          arguments: JSON.stringify({
                            question: 'Which output do you need?',
                            choices: ['Report', 'Patch'],
                          }),
                        },
                      },
                    ],
                  }
                : { content: 'Proposed completion without the required file.' },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing model port');
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    const window = await app.firstWindow();
    const taskId = await window.evaluate(async (baseUrl) => {
      const api = globalThis.window.hikari!;
      await api.agent.configure({
        provider: 'compatible',
        model: 'protocol-fixture',
        baseUrl,
        apiKey: '',
      });
      const task = await api.agent.start('Prepare a checked output', false, undefined, {
        mode: 'execute',
        maxSteps: 10,
        requireTests: false,
        checks: [
          {
            id: 'result',
            label: 'Required output file',
            kind: 'file',
            path: 'result.txt',
            exists: true,
          },
        ],
      });
      return task.id;
    }, `http://127.0.0.1:${address.port}/v1`);
    await window.reload();
    await window.getByRole('button', { name: 'Prepare a checked output' }).first().click();
    await expect(window.getByRole('region', { name: 'Agent question' }))
      .toBeVisible()
      .catch(async () => {
        await expect(window.getByText('Your input is needed')).toBeVisible();
      });
    await window.getByRole('button', { name: 'Report', exact: true }).click();
    await expect
      .poll(() =>
        window.evaluate(
          async (id) =>
            (await globalThis.window.hikari!.agent.list()).find((task) => task.id === id)?.status,
          taskId,
        ),
      )
      .toBe('failed');
    await expect(window.getByText('Acceptance failed', { exact: true })).toBeVisible();
    expect(requests).toBe(4);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
test('resumes the same durable task after the desktop process restarts', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'hikari-recovery-e2e-'));
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests++;
    if (requests === 1) {
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"In progress"}}]}\n\n');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'Recovered the saved conversation.' } }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing model port');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  let app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    let window = await app.firstWindow();
    const id = await window.evaluate(async (url) => {
      await globalThis.window.hikari!.agent.configure({
        provider: 'compatible',
        model: 'protocol-fixture',
        baseUrl: url,
        apiKey: '',
      });
      return (await globalThis.window.hikari!.agent.start('Recover this conversation')).id;
    }, baseUrl);
    await expect
      .poll(() =>
        window.evaluate(
          async (taskId) =>
            (await globalThis.window.hikari!.agent.list()).find((task) => task.id === taskId)
              ?.status,
          id,
        ),
      )
      .toBe('thinking');
    await app.close();
    app = await electron.launch({
      executablePath: require('electron') as string,
      args: ['apps/desktop'],
      env: { ...process.env, HIKARI_DATA_DIR: data },
    });
    window = await app.firstWindow();
    await expect
      .poll(() =>
        window.evaluate(
          async (taskId) =>
            (await globalThis.window.hikari!.agent.list()).find((task) => task.id === taskId)
              ?.status,
          id,
        ),
      )
      .toBe('interrupted');
    await window.evaluate(
      async (url) =>
        globalThis.window.hikari!.agent.configure({
          provider: 'compatible',
          model: 'protocol-fixture',
          baseUrl: url,
          apiKey: '',
        }),
      baseUrl,
    );
    await window.getByRole('button', { name: 'Recover this conversation' }).first().click();
    await window.getByRole('button', { name: 'Resume task' }).click();
    await expect
      .poll(() =>
        window.evaluate(
          async (taskId) =>
            (await globalThis.window.hikari!.agent.list()).find((task) => task.id === taskId)
              ?.status,
          id,
        ),
      )
      .toBe('completed');
    expect(
      await window.evaluate(async () => (await globalThis.window.hikari!.agent.list()).length),
    ).toBe(1);
    await expect(
      window.getByText('Recovered the saved conversation.', { exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
