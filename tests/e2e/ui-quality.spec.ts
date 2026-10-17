import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalPersistence } from '../../apps/desktop/src/main/persistence';
import { TaskManager } from '../../packages/agent-runtime/src';
import { translate } from '../../apps/desktop/src/renderer/i18n';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

async function bounded(dialog: Locator) {
  expect(
    await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const body = element.querySelector('.dialog-body')!;
      return (
        box.top >= 23 &&
        box.bottom <= innerHeight - 23 &&
        box.left >= 23 &&
        box.right <= innerWidth - 23 &&
        element.scrollWidth <= element.clientWidth &&
        body.scrollWidth <= body.clientWidth
      );
    }),
  ).toBe(true);
}

async function capture(page: Page, name: string) {
  await page.screenshot({ path: `test-results/ui-${name}.png`, scale: 'css' });
}

for (const language of ['en', 'zh-CN', 'ja'] as const) {
  test(`desktop controls, keyboard menus and dialogs stay readable in ${language}`, async () => {
    test.setTimeout(90000);
    const t = (key: string) => translate(language, key);
    const data = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-ui-quality-')));
    const root = path.join(data, 'Hikari-project-界面検証');
    await mkdir(path.join(root, '.agent'), { recursive: true });
    await writeFile(path.join(root, '.agent', 'mcp.json'), '{}');
    const persistence = new LocalPersistence(path.join(data, 'hakari.sqlite'));
    const task = new TaskManager().create('UI consistency · 界面优化 · 表示の確認', root);
    task.status = 'completed';
    task.events.push({
      id: 'ui-result',
      agentId: 'ui',
      taskId: task.id,
      timestamp: new Date().toISOString(),
      type: 'agent.completed',
      data: {
        text: 'Hikari workspace\n\n- Shared controls\n- Project context\n- Keyboard navigation',
      },
    });
    persistence.task(task);
    await persistence.close();
    const app = await electron.launch({
      executablePath: require('electron') as string,
      args: ['apps/desktop'],
      env: { ...process.env, HIKARI_DATA_DIR: data },
    });
    try {
      const page = await app.firstWindow();
      await page.evaluate(async (root) => {
        await window.hikari!.workspace.select(root);
        await window.hikari!.sections.create(
          'Research · 长分区名称用于检查菜单换行とキーボード操作',
        );
      }, root);
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((preferences) => window.hikari!.preferences.set(preferences), {
          theme,
          language,
        });
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute('lang', language);
        for (const viewport of [
          { width: 1480, height: 900 },
          { width: 740, height: 560 },
        ]) {
          await page.setViewportSize(viewport);
          const suffix = `${language}-${theme}-${viewport.width}`;
          const row = page.locator('.task-button').filter({ hasText: task.title });
          await row.click();
          await expect(page.locator('.conversation-project-settings')).toHaveAttribute(
            'title',
            root,
          );
          await capture(page, `${suffix}-conversation`);
          // Check shared semantic text/control pairs on both app surfaces in each theme.
          const contrasts = await page.locator('main').evaluate((element) => {
            const style = getComputedStyle(element);
            const lum = (hex: string) => {
              const value = hex.trim().slice(1);
              const full = value.length === 3 ? [...value].map((v) => v + v).join('') : value;
              const rgb = full
                .match(/../g)!
                .map((v) => parseInt(v, 16) / 255)
                .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
              return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
            };
            const ratio = (a: string, b: string) => {
              const x = lum(style.getPropertyValue(a)),
                y = lum(style.getPropertyValue(b));
              return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
            };
            return {
              text: ['--canvas-bg', '--panel-bg']
                .flatMap((bg) => ['--text-primary', '--text-secondary'].map((fg) => ratio(fg, bg)))
                .concat(ratio('--accent', '--accent-ink')),
              controls: [
                ratio('--field-border', '--field-bg'),
                ratio('--field-border', '--panel-bg'),
                ratio('--accent', '--canvas-bg'),
              ],
            };
          });
          for (const ratio of contrasts.text) expect(ratio).toBeGreaterThanOrEqual(4.5);
          for (const ratio of contrasts.controls) expect(ratio).toBeGreaterThanOrEqual(3);
          // Menus and nested actions must stay bounded near the bottom of a short viewport.
          await row.click({ button: 'right' });
          const menu = page.getByRole('menu', { name: t('Conversation actions'), exact: true });
          await expect(menu).toBeVisible();
          await page.keyboard.press('End');
          await expect(
            menu.getByRole('menuitem', { name: t('Permanently delete'), exact: true }),
          ).toBeFocused();
          const section = menu.getByRole('menuitem', { name: t('Section'), exact: true });
          await section.focus();
          await page.keyboard.press('ArrowRight');
          const submenu = page.getByRole('menu', { name: t('Section'), exact: true });
          await expect(submenu.getByRole('menuitem').first()).toBeFocused();
          await expect(submenu).toBeInViewport({ ratio: 1 });
          const longLabel = submenu.getByRole('menuitem', { name: /^Research/ });
          await expect(longLabel).toBeVisible();
          expect(
            await longLabel.locator('span').evaluate((e) => e.scrollWidth <= e.clientWidth),
          ).toBe(true);
          await capture(page, `${suffix}-menu`);
          await page.keyboard.press('ArrowLeft');
          await expect(section).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(row).toBeFocused();

          await page.getByRole('button', { name: t('Memory & extensions'), exact: true }).click();
          const settings = page.getByRole('dialog');
          const shell = await settings.boundingBox();
          for (const tab of ['Memory', 'Extensions', 'Automation and integrations']) {
            await settings.getByRole('tab', { name: t(tab), exact: true }).click();
            expect(await settings.boundingBox()).toEqual(shell);
            await bounded(settings);
          }
          await settings.getByRole('tab', { name: t('Extensions'), exact: true }).click();
          await settings.getByLabel(t('Transport'), { exact: true }).selectOption('stdio');
          const args = settings.getByLabel(t('Arguments (one per line)'), { exact: true });
          await args.fill('--inspect\n./server.ts');
          expect((await args.boundingBox())!.height).toBeGreaterThanOrEqual(88);
          await bounded(settings);
          await capture(page, `${suffix}-extensions`);
          await settings
            .getByRole('tab', { name: t('Automation and integrations'), exact: true })
            .click();
          await settings.getByText(t('Scheduled tasks'), { exact: true }).click();
          const interval = settings.getByLabel(t('Repeat every (minutes)'), { exact: true });
          await interval.focus();
          expect((await interval.boundingBox())!.width).toBeLessThanOrEqual(128);
          await capture(page, `${suffix}-automation`);
          await page.keyboard.press('Escape');

          await page.locator('.model-label').click();
          const model = page.getByRole('dialog');
          const modelBounds = await model.boundingBox();
          await model.getByText(t('Usage and compatibility'), { exact: true }).click();
          expect(await model.boundingBox()).toEqual(modelBounds);
          const effort = model.getByLabel(t('Reasoning effort'), { exact: true });
          await expect(effort.locator('option[value="high"]')).toHaveText(t('High'));
          await effort.focus();
          await bounded(model);
          await capture(page, `${suffix}-model`);
          await page.keyboard.press('Escape');

          await page.getByRole('button', { name: t('Task options'), exact: true }).click();
          const options = page.getByRole('dialog');
          await options.getByText(t('Acceptance and budgets'), { exact: true }).click();
          await options.getByRole('button', { name: t('Add test command'), exact: true }).click();
          const command = options.getByLabel(t('Executable'), { exact: true });
          await command.fill('pnpm');
          expect(await command.locator('..').innerText()).toContain(t('Executable'));
          await bounded(options);
          await capture(page, `${suffix}-options`);
          await options
            .locator('fieldset')
            .filter({ has: page.getByLabel(t('Executable'), { exact: true }) })
            .getByRole('button', { name: t('Remove'), exact: true })
            .click();
          await page.keyboard.press('Escape');

          for (const item of ['Appearance & language', 'Account & sync', 'Data & updates']) {
            await page.getByRole('button', { name: t('Settings'), exact: true }).click();
            await page.getByRole('button', { name: t(item), exact: true }).click();
            await bounded(page.getByRole('dialog'));
            if (item === 'Account & sync') {
              const email = page.getByLabel(t('Sync email'), { exact: true });
              await expect(email).toHaveAttribute('autocomplete', 'username');
              expect((await email.boundingBox())!.width).toBeLessThanOrEqual(440);
            }
            await capture(page, `${suffix}-${item.split(' ')[0]!.toLowerCase()}`);
            await page.keyboard.press('Escape');
            await expect(
              page.getByRole('button', { name: t('Settings'), exact: true }),
            ).toBeFocused();
          }
          await expect(page.locator('.global-error')).toHaveCount(0);
        }
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      expect(
        await page
          .locator('.section-toggle svg')
          .first()
          .evaluate((e) => getComputedStyle(e).transitionDuration),
      ).toBe('0s');
    } finally {
      await app.close();
      await rm(data, { recursive: true, force: true });
    }
  });
}
