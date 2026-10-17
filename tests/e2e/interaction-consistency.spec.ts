import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

test('quick suggestions use the selected language for connected and offline agents', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'hikari-language-presets-'));
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    const page = await app.firstWindow();
    const cases = [
      {
        language: 'en',
        real: [
          'Analyze this repository. Explain its architecture and key entry points.',
          'Inspect this repository and help me implement the following change:',
          'Inspect this repository, run its tests, and fix the first failing test.',
        ],
        demo: [
          'Analyze the sample project architecture and propose a plan.',
          'Fix the sample shopping cart calculation and show the diff.',
          'Fix the sample tests and explain the simulated results.',
        ],
      },
      {
        language: 'zh-CN',
        real: [
          '分析这个仓库，说明整体架构和关键入口。',
          '检查这个仓库，帮助我实现以下改动：',
          '检查这个仓库，运行测试并修复第一个失败的测试。',
        ],
        demo: [
          '分析示例项目的架构，并给出计划。',
          '修复示例购物车的金额计算，并演示 Diff。',
          '修复示例测试，并说明模拟验证结果。',
        ],
      },
      {
        language: 'ja',
        real: [
          'このリポジトリを分析し、全体の構成と主要なエントリーポイントを説明してください。',
          'このリポジトリを確認し、次の変更の実装を手伝ってください：',
          'このリポジトリを確認し、テストを実行して最初に失敗したテストを修正してください。',
        ],
        demo: [
          'サンプルプロジェクトの構成を分析し、計画を提案してください。',
          'サンプルのカートの金額計算を修正し、差分を示してください。',
          'サンプルのテストを修正し、シミュレーションの結果を説明してください。',
        ],
      },
    ] as const;
    for (const item of cases)
      for (const demo of [false, true]) {
        await page.evaluate(
          async ({ language, demo }) => {
            await window.hikari!.preferences.set({ language, theme: 'light' });
            await window.hikari!.agent.configure(
              demo
                ? { provider: 'demo', model: 'offline-demo', apiKey: '' }
                : {
                    provider: 'compatible',
                    model: 'fixture',
                    apiKey: '',
                    baseUrl: 'http://127.0.0.1:9/v1',
                  },
            );
          },
          { language: item.language, demo },
        );
        await page.reload();
        for (let index = 0; index < 3; index++) {
          await page.locator('.suggestion').nth(index).click();
          const prompt = page.locator('.composer textarea');
          await expect(prompt).toHaveValue((demo ? item.demo : item.real)[index]!);
          await expect(prompt).toBeFocused();
          expect(
            await page.locator('.composer-actions').evaluate((group) =>
              [...group.querySelectorAll('button')].every((button) => {
                const icon = button.querySelector('svg')!.getBoundingClientRect();
                const bounds = button.getBoundingClientRect();
                return Math.abs(icon.top + icon.height / 2 - bounds.top - bounds.height / 2) < 1;
              }),
            ),
          ).toBe(true);
          expect(await prompt.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
            'none',
          );
        }
        await page.screenshot({
          path: `test-results/presets-${item.language}-${demo ? 'demo' : 'connected'}.png`,
        });
      }
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});

test('all dialogs share dismissal, focus, spacing and bounded scrolling', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'hikari-dialog-contract-'));
  const root = path.join(data, 'workspace');
  await mkdir(root);
  const note = path.join(root, '说明.md');
  await writeFile(note, '# 附件预览\n测试统一弹窗交互。');
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: ['apps/desktop'],
    env: { ...process.env, HIKARI_DATA_DIR: data },
  });
  try {
    await app.evaluate(
      ({ dialog, ipcMain }, { root, note }) => {
        dialog.showOpenDialog = (async (...args: unknown[]) => {
          const options = args.at(-1) as { properties?: string[] };
          return {
            canceled: false,
            filePaths: options.properties?.includes('openDirectory') ? [root] : [note],
          };
        }) as typeof dialog.showOpenDialog;
        ipcMain.removeHandler('agent:grants');
        ipcMain.handle('agent:grants', () => [
          {
            id: 'fixture-grant',
            updatedAt: new Date().toISOString(),
            description: JSON.stringify([
              root,
              'shell',
              'shell.execute',
              { command: 'git', args: ['ls-files', '*.test.ts'], cwd: '.', timeoutMs: 30000 },
            ]),
          },
        ]);
      },
      { root, note },
    );
    const page = await app.firstWindow();
    await page.evaluate(() =>
      window.hikari!.preferences.set({ theme: 'light', language: 'zh-CN' }),
    );
    await page.reload();
    await page.getByRole('button', { name: '新增项目', exact: true }).click();
    const projectDialog = page.getByRole('dialog', { name: '创建项目', exact: true });
    await projectDialog.getByRole('button', { name: '添加文件夹', exact: true }).click();
    await projectDialog.getByRole('button', { name: '创建项目', exact: true }).click();
    await expect(projectDialog).not.toBeVisible();
    await expect(
      page.getByRole('button', { name: '打开项目 workspace', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '添加文件或图片', exact: true }).click();
    await expect(page.locator('.attachment-chip')).toHaveCount(1);
    const openers = [
      async () => {
        await page.locator('.task-options-trigger').click();
      },
      async () => {
        await page.locator('.model-label').click();
      },
      async () => {
        await page.getByRole('button', { name: '设置', exact: true }).click();
        await page.getByRole('button', { name: '外观与语言', exact: true }).click();
      },
      async () => {
        await page.getByRole('button', { name: '记忆与扩展', exact: true }).click();
      },
      async () => {
        await page.getByRole('button', { name: '预览 说明.md', exact: true }).click();
      },
    ];
    for (const [index, open] of openers.entries()) {
      for (const dismissal of ['button', 'escape', 'backdrop']) {
        await open();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toHaveCount(1);
        await expect(dialog).toHaveJSProperty('open', true);
        // DOM clicks bypass Electron's native draggable-region hit testing.
        // Every modal must disable the background title bar as well as its own surface.
        expect(
          await page.evaluate(() =>
            [...document.querySelectorAll('header, dialog[open], dialog[open] .dialog-close')].map(
              (element) => getComputedStyle(element).getPropertyValue('-webkit-app-region'),
            ),
          ),
        ).toEqual(['no-drag', 'no-drag', 'no-drag']);
        await expect(dialog.locator('.dialog-header .dialog-close')).toHaveAccessibleName('关闭');
        await expect(
          dialog.getByRole('button', { name: /^(Close|Cancel|Done|取消|完成)$/ }),
        ).toHaveCount(0);
        expect(
          await dialog.evaluate((element) => {
            const header = element.querySelector('.dialog-header')!;
            const body = element.querySelector('.dialog-body')!;
            return [
              getComputedStyle(header).paddingLeft,
              getComputedStyle(header).paddingRight,
              getComputedStyle(body).paddingLeft,
              getComputedStyle(body).paddingRight,
            ];
          }),
        ).toEqual(['24px', '24px', '24px', '24px']);
        await dialog.locator('.dialog-close').focus();
        await page.keyboard.press('Shift+Tab');
        expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
          true,
        );
        if (index === 3) {
          await expect(dialog.locator('.grant-command')).toHaveText('git ls-files *.test.ts');
          await expect(dialog.locator('.memory-entry details')).not.toHaveAttribute('open');
        }
        if (dismissal === 'button') {
          await dialog.locator('.dialog-close').click();
        } else if (dismissal === 'escape') await page.keyboard.press('Escape');
        else await page.mouse.click(4, 4);
        await expect(dialog).toHaveCount(0);
        await expect(page.locator('header')).toHaveCSS('-webkit-app-region', 'drag');
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.matches('button, summary')))
          .toBe(true);
      }
    }
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.getByRole('button', { name: '切换右侧面板', exact: true }).click();
    await openers[2]!();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary', { name: '右侧面板' })).toBeVisible();
    await page.getByRole('button', { name: '关闭面板', exact: true }).click();
    // Dense forms may fit at 700px; a short desktop window exercises real overflow.
    for (const width of [1000, 740]) {
      await page.setViewportSize({ width, height: 560 });
      await openers[3]!();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('tab', { name: '扩展', exact: true }).click();
      await dialog.getByLabel('连接方式', { exact: true }).selectOption('stdio');
      expect(
        await dialog.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const body = element.querySelector('.settings-panel:not([hidden])')!;
          return (
            bounds.top >= 24 &&
            bounds.bottom <= innerHeight - 24 &&
            body.scrollHeight > body.clientHeight
          );
        }),
      ).toBe(true);
      await page.screenshot({ path: `test-results/shared-dialog-${width}.png` });
      await page.keyboard.press('Escape');
    }
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});
