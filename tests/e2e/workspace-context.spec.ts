import { addWorkspaceProject } from './desktop-window';
import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

test('opening a workspace leaves conversation mode and wraps long question choices', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'hikari-workspace-context-'));
  const root = path.join(data, 'vue-h5-template');
  await mkdir(root);
  const manifest = JSON.stringify({ name: 'workspace-context-fixture' });
  await writeFile(path.join(root, 'package.json'), manifest);
  const choices = [
    '给你一个 GitHub / GitLab 仓库链接，并说明需要重点阅读的业务模块',
    '我上传代码压缩包或若干关键文件，请根据实际源码解释项目结构',
    'README、ディレクトリ構造と設定ファイルを直接貼り付けます',
    'First provide a detailed project reading checklist with concrete verification steps',
  ];
  let requests = 0;
  let projectTools: string[] = [];
  let projectRead = false;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const tools = (body.tools ?? []).map(
      (tool: { function: { name: string } }) => tool.function.name,
    );
    requests++;
    let message;
    if (requests === 1) {
      message = {
        content: '',
        tool_calls: [
          {
            id: 'ask-source',
            type: 'function',
            function: {
              name: 'ask_user',
              arguments: JSON.stringify({ question: 'How should I read this project?', choices }),
            },
          },
        ],
      };
    } else if (tools.includes('read_file') && !projectRead) {
      projectTools = tools;
      projectRead = true;
      message = {
        content: '',
        tool_calls: [
          {
            id: 'read-project',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'package.json' }) },
          },
        ],
      };
    } else if (tools.includes('read_file')) {
      const result = body.messages.findLast((item: { role: string }) => item.role === 'tool');
      message = { content: `Read package.json: ${result?.content ?? 'Missing tool result'}` };
    } else {
      message = { content: 'Conversation answer received.' };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    const page = await app.firstWindow();
    const chatId = await page.evaluate(async (baseUrl) => {
      const api = window.hikari!;
      await api.agent.configure({
        provider: 'compatible',
        model: 'context-fixture',
        baseUrl,
        apiKey: '',
      });
      return (
        await api.agent.start('Read this project', false, undefined, {
          mode: 'execute',
          maxSteps: 10,
          requireTests: false,
        })
      ).id;
    }, `http://127.0.0.1:${address.port}/v1`);
    await page.reload();
    await page.locator('.task-button').filter({ hasText: 'Read this project' }).click();
    const question = page.locator('.user-question');
    await expect(question).toBeVisible();
    await expect(page.locator('.composer-bottom')).toContainText('Conversation only');
    for (const width of [1480, 1000]) {
      await page.setViewportSize({ width, height: 960 });
      const layout = await question.evaluate((element) => {
        const card = element.getBoundingClientRect();
        return {
          overflow: element.scrollWidth - element.clientWidth,
          inside: [...element.querySelectorAll('.actions .button')].every((button) => {
            const rect = button.getBoundingClientRect();
            return (
              rect.left >= card.left &&
              rect.right <= card.right &&
              button.scrollWidth <= button.clientWidth + 1
            );
          }),
        };
      });
      expect(layout).toEqual({ overflow: 0, inside: true });
    }
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, root);
    await addWorkspaceProject(page);
    await expect(page.locator('.welcome')).toBeVisible();
    await expect(page.locator('.composer-bottom')).toContainText('vue-h5-template');
    expect(
      await page.evaluate(
        async (id) => (await window.hikari!.agent.list()).find((task) => task.id === id)?.status,
        chatId,
      ),
    ).toBe('waiting_input');
    await page
      .getByRole('textbox', { name: 'Task prompt', exact: true })
      .fill('Read package.json using the local tool');
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: /Read package.json using the local tool/ }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.hikari!.agent.list()).find(
              (task) => task.prompt === 'Read package.json using the local tool',
            )?.status,
        ),
      )
      .toBe('completed');
    const projectTask = await page.evaluate(async () =>
      (await window.hikari!.agent.list()).find(
        (task) => task.prompt === 'Read package.json using the local tool',
      ),
    );
    expect(projectTask?.chat).toBeFalsy();
    expect(projectTask?.parentTaskId).toBeUndefined();
    expect(projectTask?.workspace).toBe(await realpath(root));
    expect(projectTools).toContain('read_file');
    await expect(page.locator('.task-view')).toContainText('workspace-context-fixture');
    expect(await readFile(path.join(root, 'package.json'), 'utf8')).toBe(manifest);

    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await addWorkspaceProject(page, true);
    await expect(
      page.getByRole('heading', { name: /Read package.json using the local tool/ }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Open project vue-h5-template', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.composer-bottom')).toContainText('vue-h5-template');
    await page.locator('.task-button').filter({ hasText: 'Read this project' }).click();
    await expect(page.locator('.composer-bottom')).toContainText('Conversation only');
    await page.getByRole('button', { name: choices[0], exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          async (id) => (await window.hikari!.agent.list()).find((task) => task.id === id)?.status,
          chatId,
        ),
      )
      .toBe('completed');
    await page
      .locator('.project-group')
      .getByRole('button', { name: 'New task in vue-h5-template', exact: true })
      .click();
    await expect(page.locator('.welcome')).toBeVisible();
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
