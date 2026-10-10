import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitService } from '../../packages/git/src';
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
test('desktop runs the development graph through real tools and verification, then manages and exports history', async () => {
  test.setTimeout(60000);
  const data = await mkdtemp(path.join(tmpdir(), 'hikari-workflow-ui-'));
  const root = path.join(data, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'result.txt'), 'old\n');
  const git = new GitService(root);
  await git.run(['init']);
  await git.run(['add', 'result.txt']);
  await git.run([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'fixture',
  ]);
  await writeFile(path.join(root, 'untracked.txt'), 'user-owned untracked content\n');
  const counts = new Map<string, number>();
  const body = (name: string, input: unknown) => ({
    content: '',
    tool_calls: [
      {
        id: `call-${name}-${Date.now()}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(input) },
      },
    ],
  });
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const input = JSON.parse(text) as {
      messages: { role: string; content: string }[];
      tools?: { function: { name: string } }[];
    };
    const system = input.messages[0]!.content;
    const stage = system.includes('INVESTIGATOR:')
      ? 'investigate'
      : system.includes('PLANNER:')
        ? 'plan'
        : system.includes('REVIEWER:')
          ? 'review'
          : system.includes('IMPLEMENTER:')
            ? 'implement'
            : 'complete';
    const count = counts.get(stage) ?? 0;
    counts.set(stage, count + 1);
    let message;
    if (stage === 'investigate')
      message =
        count === 0
          ? body('read_file', { path: 'result.txt' })
          : body('handoff_stage', {
              report:
                'result.txt contains old content and must be changed while preserving other files. Inspection completed using read_file.',
            });
    else if (stage === 'plan')
      message =
        count === 0
          ? body('update_plan', {
              steps: [
                {
                  id: 'edit',
                  text: 'Edit result.txt and run the configured acceptance command',
                  status: 'in_progress',
                },
              ],
            })
          : body('handoff_stage', {
              report:
                'Replace the inspected text file and pass the configured test command before the independent reviewer checks the result.',
            });
    else if (stage === 'implement')
      message =
        count === 0
          ? body('write_file', {
              path: 'result.txt',
              content: 'verified\n',
              expectedHash: createHash('sha256').update('old\n').digest('hex'),
            })
          : { content: 'Implementation is ready for acceptance.' };
    else if (stage === 'review') {
      if (
        input.tools?.some((tool) =>
          ['write_file', 'shell', 'run_tests'].includes(tool.function.name),
        )
      )
        throw new Error('Review tools were not scoped');
      message =
        count === 0
          ? body('read_file', { path: 'result.txt' })
          : body('submit_review', {
              passed: true,
              findings: [],
              evidence:
                'Independent read_file verified result.txt equals verified, and the recorded acceptance command passed for the latest revision.',
            });
    } else message = { content: 'Verified implementation and independent review completed.' };
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No model port');
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, root);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    const id = await page.evaluate(
      async ({ endpoint, node, execution }) => {
        const api = window.hikari!;
        await api.agent.configure({
          provider: 'deepseek',
          model: 'fixture',
          baseUrl: endpoint,
          apiKey: 'fixture-private-key',
        });
        api.agent.subscribe((event) => {
          if (event.type === 'permission.requested') {
            const request = event.data.request as { id: string };
            void api.agent.approve(event.taskId, request.id, 'once');
          }
        });
        return (
          await api.agent.start(
            'Write verified to result.txt and independently review the result',
            true,
            undefined,
            {
              mode: 'execute',
              execution,
              workflow: 'development',
              worktreeSource: 'working-tree',
              maxSteps: 20,
              checks: [
                {
                  id: 'test',
                  kind: 'test',
                  label: 'Exact result',
                  command: node,
                  args: [
                    '-e',
                    "const assert=require('node:assert/strict');assert.equal(require('fs').readFileSync('result.txt','utf8'),'verified\\n')",
                  ],
                  cwd: '.',
                },
              ],
            },
          )
        ).id;
      },
      {
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        node: process.execPath,
        // Windows CI does not provision the Linux Docker image required for restricted execution.
        execution: process.platform === 'win32' ? ('host' as const) : ('restricted' as const),
      },
    );
    await expect
      .poll(
        async () =>
          page.evaluate(
            async (id) =>
              (await window.hikari!.agent.list()).find((task) => task.id === id)?.status,
            id,
          ),
        { timeout: 30000 },
      )
      .toBe('completed');
    const task = await page.evaluate(
      async (id) => (await window.hikari!.agent.list()).find((task) => task.id === id)!,
      id,
    );
    expect(task.runSummary?.verification?.passed).toBe(true);
    expect(task.runSummary?.tests.at(-1)?.status).toBe('passed');
    expect(await readFile(path.join(root, 'result.txt'), 'utf8')).toBe('old\n');
    expect(await readFile(path.join(task.worktree!, 'result.txt'), 'utf8')).toBe('verified\n');
    expect(await readFile(path.join(task.worktree!, 'untracked.txt'), 'utf8')).toContain(
      'user-owned',
    );
    expect(
      task.events
        .filter((event) => event.type === 'workflow.stage')
        .map((event) => event.data.stage),
    ).toEqual(['investigate', 'plan', 'implement', 'review', 'complete']);
    const preview = await page.evaluate((id) => window.hikari!.worktree.preview(id), id);
    expect(preview.applicable).toBe(true);
    await page.evaluate(({ id, previewId }) => window.hikari!.worktree.apply(id, previewId), {
      id,
      previewId: preview.id,
    });
    expect(await readFile(path.join(root, 'result.txt'), 'utf8')).toBe('verified\n');
    await page.evaluate((id) => window.hikari!.worktree.undoDelivery(id), id);
    expect(await readFile(path.join(root, 'result.txt'), 'utf8')).toBe('old\n');
    const archive = await page.evaluate((id) => window.hikari!.worktree.archive(id), id);
    const archived = JSON.parse(await readFile(archive, 'utf8')) as {
      content: Record<string, { data: string }>;
    };
    expect(Buffer.from(archived.content['untracked.txt']!.data, 'base64').toString()).toContain(
      'user-owned untracked content',
    );
    await expect(readFile(path.join(task.worktree!, 'result.txt'))).rejects.toThrow();
    await page.evaluate((id) => window.hikari!.worktree.restore(id), id);
    expect(await readFile(path.join(task.worktree!, 'result.txt'), 'utf8')).toBe('verified\n');
    await page.evaluate(async (id) => {
      await window.hikari!.agent.rename(id, 'Reviewed result');
      await window.hikari!.agent.archive(id, true);
    }, id);
    expect(
      await page.evaluate(
        async (id) => (await window.hikari!.agent.list()).find((task) => task.id === id)?.archived,
        id,
      ),
    ).toBe(true);
    const exported = path.join(data, 'conversation.json');
    await app.evaluate(({ dialog }, filename) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
    }, exported);
    await page.evaluate((id) => window.hikari!.agent.export(id), id);
    expect(await readFile(exported, 'utf8')).not.toContain('fixture-private-key');
    await app.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
    }, exported);
    const imported = await page.evaluate(() => window.hikari!.agent.import());
    expect(imported?.imported).toBe(true);
    expect(imported?.resumable).toBeUndefined();
    const profiles = await page.evaluate(() => window.hikari!.agent.profiles());
    expect(profiles[0]?.apiKey).toBe('');
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
