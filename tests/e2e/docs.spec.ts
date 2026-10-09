import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

let preview: ChildProcess;
let url: string;
const base = process.env.DOCS_BASE_PATH || '/';
test.beforeAll(async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('No preview port');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  url = `http://127.0.0.1:${port}${base.replace(/\/$/, '')}`;
  preview = spawn(
    process.execPath,
    [
      'node_modules/vitepress/bin/vitepress.js',
      'preview',
      'docs',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    { stdio: 'ignore' },
  );
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${url}/`)).ok;
        } catch {
          return false;
        }
      },
      { timeout: 10000 },
    )
    .toBe(true);
});
test.afterAll(async () => {
  if (preview && preview.exitCode === null) {
    preview.kill('SIGTERM');
    await once(preview, 'exit');
  }
});

const guides = [
  {
    prefix: '',
    lang: 'en-US',
    start: 'Get started',
    heading: 'Getting started',
    search: 'Search docs',
    query: 'Choose a theme',
    appearance: 'Appearance and language',
    navigation: 'Menu',
    installation: 'Installation',
    languageMenu: 'Change language',
    nextLabel: '简体中文',
    nextPrefix: '/zh',
    nextLang: 'zh-CN',
    nextHeading: '外观与语言',
  },
  {
    prefix: '/zh',
    lang: 'zh-CN',
    start: '开始使用',
    heading: '快速开始',
    search: '搜索文档',
    query: '选择主题',
    appearance: '外观与语言',
    navigation: '文档导航',
    installation: '安装',
    languageMenu: '切换语言',
    nextLabel: '日本語',
    nextPrefix: '/ja',
    nextLang: 'ja',
    nextHeading: '外観と言語',
  },
  {
    prefix: '/ja',
    lang: 'ja',
    start: 'はじめる',
    heading: 'はじめに',
    search: 'ドキュメントを検索',
    query: 'テーマ',
    appearance: '外観と言語',
    navigation: 'メニュー',
    installation: 'インストール',
    languageMenu: '言語を変更',
    nextLabel: 'English',
    nextPrefix: '',
    nextLang: 'en-US',
    nextHeading: 'Appearance and language',
  },
];

for (const guide of guides) {
  test(`user guide ${guide.lang}: pages, search, mobile navigation and corresponding language switch`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const route of [
      'index',
      'getting-started',
      'installation',
      'usage',
      'attachments',
      'configuration',
      'appearance',
      'extensions',
      'cli',
      'troubleshooting',
    ]) {
      const response = await request.get(
        `${url}${guide.prefix}/${route === 'index' ? '' : route + '.html'}`,
      );
      expect(response.ok()).toBe(true);
      const html = await response.text();
      expect(html).toContain(`lang="${guide.lang}"`);
      expect(html).not.toMatch(
        /forge|product-requirements|href="[^"]*(?:architecture|development|progress|backend|packaging)\.html/i,
      );
    }
    await page.goto(`${url}${guide.prefix}/`);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
      'href',
      `${base}hikari-icon.svg`,
    );
    const icon = await request.get(`${url}/hikari-icon.svg`);
    expect(icon.ok()).toBe(true);
    expect(icon.headers()['content-type']).toContain('image/svg+xml');
    await expect(page.locator('html')).toHaveAttribute('lang', guide.lang);
    await expect(page.getByRole('heading', { name: /Hikari/ })).toBeVisible();
    await page.getByRole('link', { name: guide.start, exact: true }).last().click();
    await expect(
      page.getByRole('heading', { name: new RegExp(`^${guide.heading}`) }),
    ).toBeVisible();
    await page.getByRole('button', { name: guide.search, exact: true }).click();
    await page.locator('#localsearch-input').fill(guide.query);
    const results = page.locator('#localsearch-list');
    await expect(results).toContainText(guide.appearance);
    await results.getByRole('link').filter({ hasText: guide.appearance }).first().click();
    await expect(page).toHaveURL(new RegExp(`${guide.prefix}/appearance`));
    await expect(
      page.getByRole('heading', { name: new RegExp(`^${guide.appearance}`) }),
    ).toBeVisible();
    await expect(page.locator('.VPSidebarItem.is-active')).toContainText(guide.appearance);
    await page.screenshot({ path: `test-results/hikari-docs-${guide.lang}.png`, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    const navigation = page.getByRole('button', { name: guide.navigation, exact: true });
    const sidebar = page.locator('.VPSidebar');
    await expect(navigation).toBeVisible();
    await expect
      .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().right))
      .toBeLessThanOrEqual(0);
    await navigation.click();
    await expect(navigation).toHaveAttribute('aria-expanded', 'true');
    await expect
      .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().left))
      .toBe(0);
    await sidebar.getByRole('link', { name: guide.installation, exact: true }).click();
    await expect(
      page.getByRole('heading', { name: new RegExp(`^${guide.installation}`) }),
    ).toBeVisible();
    await expect(page.locator('.VPSidebarItem.is-active')).toContainText(guide.installation);
    await expect(navigation).toHaveAttribute('aria-expanded', 'false');
    await expect
      .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().right))
      .toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/hikari-docs-mobile-${guide.lang}.png`,
      fullPage: true,
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${url}${guide.prefix}/appearance.html`);
    await page.getByRole('button', { name: guide.languageMenu, exact: true }).hover();
    await page
      .locator('.VPNavBarTranslations')
      .getByRole('link', { name: guide.nextLabel, exact: true })
      .click();
    await expect(page).toHaveURL(`${url}${guide.nextPrefix}/appearance.html`);
    await expect(page.locator('html')).toHaveAttribute('lang', guide.nextLang);
    await expect(
      page.getByRole('heading', { name: new RegExp(`^${guide.nextHeading}`) }),
    ).toBeVisible();
  });
}
