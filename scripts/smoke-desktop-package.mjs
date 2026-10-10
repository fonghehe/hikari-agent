import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, access, writeFile, mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tsImport } from 'tsx/esm/api';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { pdfFixture, docxFixture, imageFixture } = await tsImport(
  '../tests/fixtures/attachment-files.ts',
  import.meta.url,
);

const defaultExecutable =
  process.platform === 'darwin'
    ? `apps/desktop/release/${process.arch === 'x64' ? 'mac' : `mac-${process.arch}`}/Hikari.app/Contents/MacOS/Hikari`
    : process.platform === 'win32'
      ? `apps/desktop/release/${process.arch === 'x64' ? 'win-unpacked' : `win-${process.arch}-unpacked`}/Hikari.exe`
      : `apps/desktop/release/${process.arch === 'x64' ? 'linux-unpacked' : `linux-${process.arch}-unpacked`}/hikari`;
const executablePath = path.resolve(process.argv[2] ?? defaultExecutable);
await access(executablePath);
const directory = await mkdtemp(path.join(tmpdir(), 'hikari-package-smoke-'));
let app;
let server;
try {
  app = await electron.launch({
    executablePath,
    env: {
      ...process.env,
      HIKARI_DATA_DIR: directory,
      PLAYWRIGHT_BROWSERS_PATH: path.join(directory, 'empty-browser-cache'),
    },
  });
  const metadata = await app.evaluate(
    ({ app, nativeImage }, path) => ({
      packaged: app.isPackaged,
      name: app.getName(),
      icon: !nativeImage.createFromPath(`${path}/icons/hikari.png`).isEmpty(),
    }),
    await app.evaluate(() => process.resourcesPath),
  );
  expect(metadata).toEqual({ packaged: true, name: 'Hikari', icon: true });
  const page = await app.firstWindow();
  expect(await page.evaluate(() => typeof globalThis.require)).toBe('undefined');
  await expect(page.getByRole('heading', { name: /A little direction/ })).toBeVisible();
  await page.getByRole('textbox', { name: 'Task prompt', exact: true }).fill('你好');
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect(page.locator('[data-event-type="agent.completed"]')).toContainText('你好！');
  const files = ['report.pdf', 'requirements.docx', 'design.png'].map((name) =>
    path.join(directory, name),
  );
  await writeFile(files[0], pdfFixture());
  await writeFile(files[1], await docxFixture());
  await writeFile(files[2], await imageFixture());
  await page.getByRole('button', { name: /New task/ }).click();
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
  }, files);
  await page.getByRole('button', { name: 'Attach files or images', exact: true }).click();
  await expect(page.locator('.composer .attachment-chip')).toHaveCount(3);
  await page.getByRole('button', { name: 'Preview design.png', exact: true }).click();
  await expect(page.locator('.attachment-full-image')).toBeVisible();
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  const answer = page.locator('[data-event-type="agent.completed"]');
  await expect(answer).toContainText('revenue 1200');
  await expect(answer).toContainText('attachment questions');
  await expect(answer).toContainText('demo does not interpret');
  await page.getByRole('button', { name: 'Appearance & language', exact: true }).click();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => window.hikari.preferences.get())).toEqual({
    theme: 'light',
    language: 'en',
  });
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  }, directory);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await page.getByRole('button', { name: /New task/ }).click();
  await page.getByRole('button', { name: 'terminal', exact: true }).click();
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click();
  if (process.platform === 'win32')
    await expect(page.locator('.terminal-panel')).toContainText(/PS [^>]*>/);
  const input = page.locator('.xterm-helper-textarea');
  await input.focus();
  const command =
    process.platform === 'win32'
      ? "Write-Output ('HIKARI_PACKAGE_' + 'VERIFIED')"
      : "printf 'HIKARI_PACKAGE_%s\\n' VERIFIED";
  await input.pressSequentially(command, { delay: 1 });
  await input.press('Enter');
  await expect(page.locator('.terminal-panel')).toContainText('HIKARI_PACKAGE_VERIFIED');
  const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(1000, 160);
  const context = canvas.getContext('2d');
  context.fillStyle = 'white';
  context.fillRect(0, 0, 1000, 160);
  context.fillStyle = 'black';
  context.font = 'bold 64px sans-serif';
  context.fillText('HIKARI INVOICE 12345', 30, 100);
  const recognized = await page.evaluate(
    async (bytes) => {
      const batch = await window.hikari.attachments.import([
        { name: 'invoice.png', bytes: new Uint8Array(bytes) },
      ]);
      if (batch.errors.length) throw new Error(JSON.stringify(batch.errors));
      return window.hikari.attachments.read(batch.items[0].id);
    },
    [...canvas.toBuffer('image/png')],
  );
  expect(recognized.ocr).toBe(true);
  expect(recognized.text).toContain('12345');

  const runtimeRoot = path.join(directory, 'runtime-workspace');
  await mkdir(runtimeRoot);
  let endpoint;
  server = createServer(async (req, res) => {
    if (req.url === '/page') {
      res.setHeader('content-type', 'text/html');
      res.end('<h1>PACKAGED_BROWSER_VERIFIED</h1>');
      return;
    }
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const observations = JSON.parse(body).messages.filter((message) => message.role === 'tool');
    const message = observations.length
      ? {
          content:
            observations.some((item) => item.content.includes('PACKAGED_BROWSER_VERIFIED')) &&
            observations.some((item) => item.content.includes('"exitCode":0'))
              ? 'Packaged execution verified.'
              : 'Packaged execution failed.',
        }
      : {
          content: '',
          tool_calls: [
            {
              id: 'packaged-test',
              type: 'function',
              function: {
                name: 'run_tests',
                arguments: JSON.stringify({
                  command: process.execPath,
                  args: [
                    '-e',
                    "require('fs').writeFileSync('sandbox-output.txt','sandbox verified')",
                  ],
                }),
              },
            },
            {
              id: 'packaged-browser',
              type: 'function',
              function: {
                name: 'web_read',
                arguments: JSON.stringify({ url: endpoint + '/page' }),
              },
            },
          ],
        };
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  }, runtimeRoot);
  const taskId = await page.evaluate(async (endpoint) => {
    await window.hikari.workspace.open();
    await window.hikari.agent.configure({
      provider: 'compatible',
      model: 'protocol-fixture',
      apiKey: '',
      baseUrl: endpoint + '/v1',
    });
    window.hikari.agent.subscribe((event) => {
      if (event.type === 'permission.requested')
        void window.hikari.agent.approve(event.taskId, event.data.request.id, 'session');
    });
    return (
      await window.hikari.agent.start('Validate packaged execution tools', false, undefined, {
        mode: 'execute',
        maxSteps: 5,
        requireTests: false,
        execution: 'restricted',
        checks: [
          {
            id: 'output',
            label: 'Sandbox output',
            kind: 'file',
            path: 'sandbox-output.txt',
            exists: true,
            contains: 'sandbox verified',
          },
        ],
      })
    ).id;
  }, endpoint);
  await expect
    .poll(
      () =>
        page.evaluate(
          async (id) => (await window.hikari.agent.list()).find((task) => task.id === id)?.status,
          taskId,
        ),
      { timeout: 30000 },
    )
    .toBe('completed');
  const task = await page.evaluate(
    async (id) => (await window.hikari.agent.list()).find((task) => task.id === id),
    taskId,
  );
  expect(task.events.find((event) => event.type === 'agent.completed')?.data.text).toBe(
    'Packaged execution verified.',
  );
  expect(await readFile(path.join(runtimeRoot, 'sandbox-output.txt'), 'utf8')).toBe(
    'sandbox verified',
  );
  await expect(page.locator('.global-error')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/packaged-app.png' });
  console.log(
    'Packaged Hikari: icon, secure IPC, offline Q&A, attachments, actual offline OCR, bundled Chromium without cache, OS sandbox execution, acceptance, theme and native PTY passed.',
  );
} finally {
  if (app) await app.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(directory, { recursive: true, force: true });
}
