import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test, expect, _electron as electron } from '@playwright/test';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
let directory: string;
test.beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'forge-demo-e2e-'));
});
test.afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const launch = () =>
  electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: directory },
  });

test('offline Q&A, pause/resume, follow-up, retry, cancel, history and narrow panel navigation', async () => {
  const app = await launch();
  try {
    const window = await app.firstWindow();
    await expect(
      window.getByText('Try offline Q&A without configuring a model.', { exact: false }),
    ).toBeVisible();
    await window.getByRole('textbox', { name: 'Task prompt', exact: true }).fill('你好');
    await window.getByRole('button', { name: 'Start task', exact: true }).click();
    const active = window.getByRole('region', { name: 'Active task' });
    const first = await active.getAttribute('data-task-id');
    await expect(window.getByRole('region', { name: 'Live response' })).toBeVisible();
    await window.getByRole('button', { name: 'Pause task', exact: true }).click();
    await expect(window.getByRole('button', { name: 'Pause task', exact: true })).toBeDisabled();
    await expect(window.locator('.local-pill')).toContainText('paused');
    await window.getByRole('button', { name: 'Resume task', exact: true }).click();
    await expect(window.locator('[data-event-type="agent.completed"]')).toContainText('你好！');
    await expect(window.getByRole('button', { name: 'Pause task', exact: true })).toBeDisabled();
    await expect(window.getByRole('button', { name: 'Cancel task', exact: true })).toBeDisabled();
    expect(await window.evaluate(() => globalThis.window.hikari!.agent.configured())).toBe(false);
    const tasks = await window.evaluate(() => globalThis.window.hikari!.agent.list());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.demo).toBe(true);
    expect(tasks[0]?.runSummary?.tests).toEqual([]);
    await window.getByRole('textbox', { name: 'Follow-up prompt' }).fill('继续说明');
    await window.getByRole('button', { name: 'Send follow-up', exact: true }).click();
    await expect(window.locator('[data-event-type="agent.completed"]')).toContainText(
      '继续上一轮“你好”',
    );
    const followup = await active.getAttribute('data-task-id');
    expect(followup).not.toBe(first);
    await window.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(active).not.toHaveAttribute('data-task-id', followup!);
    await window.getByRole('button', { name: 'Cancel task', exact: true }).click();
    await expect(window.locator('.local-pill')).toContainText('cancelled');
    await window.getByRole('button', { name: /^Tasks/ }).click();
    await expect(window.getByRole('region', { name: 'Task history' })).toBeVisible();
    await expect(window.locator('.history-row')).toHaveCount(3);
    await window.getByRole('textbox', { name: 'Search tasks' }).fill('no matching task');
    await expect(window.getByText('No matching tasks.', { exact: false })).toBeVisible();
    await window.getByRole('textbox', { name: 'Search tasks' }).fill('');
    await window.locator('.history-row').last().click();
    await expect(active).toHaveAttribute('data-task-id', first!);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(1000, 700);
    });
    await window.getByRole('button', { name: 'Repository', exact: true }).click();
    await expect(window.getByRole('complementary', { name: 'Right panel' })).toBeVisible();
    await window.getByRole('treeitem', { name: 'src/cart.ts', exact: true }).click();
    await expect(window.locator('.monaco-editor')).toBeVisible();
    await window.screenshot({ path: 'test-results/demo-narrow.png' });
    await window.keyboard.press('Escape');
    await expect(window.getByRole('complementary', { name: 'Right panel' })).toBeHidden();
    await window.getByRole('button', { name: 'Toggle right panel', exact: true }).click();
    await expect(
      window.getByRole('button', { name: '← Files · src/cart.ts', exact: true }),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await window.getByRole('textbox', { name: 'Follow-up prompt' }).fill('draft to clear');
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+n' : 'Control+n');
    await expect(window.getByRole('textbox', { name: 'Task prompt', exact: true })).toHaveValue('');
    await expect(window.getByRole('textbox', { name: 'Task prompt', exact: true })).toBeFocused();
    await expect(window.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('demo Plan, Execute, simulated Diff review and restored sample state', async () => {
  let app = await launch();
  let original = '';
  let child = '';
  try {
    const window = await app.firstWindow();
    await window.getByRole('button', { name: /Understand a codebase/ }).click();
    await expect(window.getByRole('textbox', { name: 'Task prompt', exact: true })).toHaveValue(
      '分析示例项目的架构，并给出计划。',
    );
    await window.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(window.locator('[data-event-type="agent.completed"]')).toContainText('示例项目');
    original = (await window
      .getByRole('region', { name: 'Active task' })
      .getAttribute('data-task-id'))!;
    await expect(window.getByRole('region', { name: 'Task plan' })).toBeVisible();
    expect(
      await window.evaluate(
        async (id) => (await globalThis.window.hikari!.git.changes(id)).length,
        original,
      ),
    ).toBe(0);
    await window.getByRole('button', { name: 'Use plan in Execute', exact: true }).click();
    await window.getByRole('button', { name: 'Send follow-up', exact: true }).click();
    await expect(window.locator('[data-event-type="agent.completed"]')).toContainText(
      '示例修复完成',
    );
    child = (await window
      .getByRole('region', { name: 'Active task' })
      .getAttribute('data-task-id'))!;
    await expect(window.getByRole('region', { name: 'Execution evidence' })).toContainText(
      'Simulation summary',
    );
    await expect(window.getByRole('region', { name: 'Execution evidence' })).toContainText(
      'No tests run',
    );
    await window.getByRole('button', { name: /Review 1 tracked file changes/ }).click();
    await window.getByRole('button', { name: 'src/cart.ts', exact: true }).click();
    await expect(window.locator('.monaco-diff-editor')).toBeVisible();
    await window.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(window.getByText('Accepted', { exact: true })).toBeVisible();
    await window.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(window.getByText('Undone', { exact: true })).toBeVisible();
    expect(
      await window.evaluate(
        (id) => globalThis.window.hikari!.workspace.read('src/cart.ts', id),
        child,
      ),
    ).toContain('price + quantity');
    await expect(window.locator('[data-event-type="agent.completed"]')).toContainText(
      '示例修复完成',
    );
    await window.screenshot({ path: 'test-results/demo-diff.png' });
    await app.close();
    app = await launch();
    const restored = await app.firstWindow();
    await restored.locator('.task-button').first().click();
    await expect(restored.locator('[data-event-type="agent.completed"]')).toContainText(
      '示例修复完成',
    );
    const tasks = await restored.evaluate(() => globalThis.window.hikari!.agent.list());
    expect(tasks.every((task) => task.demo)).toBe(true);
    expect(
      await restored.evaluate(
        (id) => globalThis.window.hikari!.workspace.read('src/cart.ts', id),
        child,
      ),
    ).toContain('price + quantity');
    await restored.getByRole('button', { name: 'diff', exact: true }).click();
    await expect(restored.getByText('Undone', { exact: true })).toBeVisible();
    await expect(restored.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('settings can explicitly return to offline demo and a cancelled workspace picker preserves the draft', async () => {
  const app = await launch();
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => ({
        canceled: true,
        filePaths: [],
      })) as typeof dialog.showOpenDialog;
    });
    const page = await app.firstWindow();
    await page.getByRole('textbox', { name: 'Task prompt', exact: true }).fill('保留这个草稿');
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.getByText('Workspace selection cancelled.', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Task prompt', exact: true })).toHaveValue(
      '保留这个草稿',
    );
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(1000, 700);
    });
    await page.getByRole('button', { name: 'Configure model', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Model settings' })).toBeVisible();
    await page.getByLabel('Model', { exact: true }).fill('fixture');
    await page.getByLabel('Base URL').fill('http://127.0.0.1:1/v1');
    await page.getByRole('button', { name: 'Connect model', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Model settings', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Model settings', exact: true }).click();
    await page.getByRole('button', { name: 'Use offline demo', exact: true }).click();
    expect(await page.evaluate(() => globalThis.window.hikari!.agent.configured())).toBe(false);
    await expect(page.getByRole('textbox', { name: 'Task prompt', exact: true })).toHaveValue(
      '保留这个草稿',
    );
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(page.locator('[data-event-type="agent.completed"]')).toContainText('模拟回答');
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('terminal button opens a real shell without a model, captures startup output and handles exit', async () => {
  const app = await launch();
  try {
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [directory],
      })) as typeof dialog.showOpenDialog;
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
    }, directory);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await page.getByRole('button', { name: 'terminal', exact: true }).click();
    await page.getByRole('button', { name: 'Open terminal', exact: true }).click();
    await expect(page.locator('.xterm')).toBeVisible();
    const input = page.locator('.xterm-helper-textarea');
    await input.focus();
    await input.pressSequentially("printf 'FORGE_UI_%s\\n' VERIFIED", { delay: 1 });
    await input.press('Enter');
    await expect(page.locator('.terminal-panel')).toContainText('FORGE_UI_VERIFIED');
    await input.pressSequentially('exit');
    await input.press('Enter');
    await expect(
      page.getByText('Terminal exited. Restart to open a new session.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Restart terminal', exact: true }).click();
    await expect(
      page.getByText('Terminal exited. Restart to open a new session.', { exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
