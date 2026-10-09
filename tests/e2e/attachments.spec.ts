import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test, expect, _electron as electron } from '@playwright/test';
import { imageFixture, pdfFixture, docxFixture } from '../fixtures/attachment-files';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
let directory: string;
test.beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'hikari-attachments-'));
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

test('native picker parses PDF/DOCX, previews, sends attachment-only questions and restores history', async () => {
  const files = [path.join(directory, 'report.pdf'), path.join(directory, 'spec.docx')];
  await writeFile(files[0]!, pdfFixture());
  await writeFile(files[1]!, await docxFixture());
  let app = await launch();
  try {
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: files,
      })) as typeof dialog.showOpenDialog;
    }, files);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Attach files or images', exact: true }).click();
    await expect(page.locator('.composer .attachment-chip')).toHaveCount(2);
    await page.getByRole('button', { name: 'Preview report.pdf', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Preview report.pdf' })).toContainText(
      'revenue 1200',
    );
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(page.locator('[data-event-type="agent.completed"]')).toContainText('report.pdf');
    await expect(page.locator('[data-event-type="agent.completed"]')).toContainText(
      'attachment questions',
    );
    await expect(page.locator('.composer .attachment-chip')).toHaveCount(0);
    for (const prompt of ['Tell me more', 'Explain the document again']) {
      await page.getByRole('textbox', { name: 'Follow-up prompt' }).fill(prompt);
      await page.getByRole('button', { name: 'Send follow-up', exact: true }).click();
      await expect(page.locator('[data-event-type="agent.completed"]')).toContainText(
        'revenue 1200',
      );
    }
    await app.close();
    app = await launch();
    const restored = await app.firstWindow();
    await restored.locator('.task-button').last().click();
    await restored.getByRole('button', { name: 'Preview spec.docx', exact: true }).click();
    await expect(restored.getByRole('dialog', { name: 'Preview spec.docx' })).toContainText(
      'attachment questions',
    );
    await restored.getByRole('button', { name: 'Close preview', exact: true }).click();
    await restored.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(restored.locator('[data-event-type="agent.completed"]')).toContainText(
      'report.pdf',
    );
    await expect(restored.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('drop, native screenshot paste, removal, partial errors and conversation drafts', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await page.getByRole('textbox', { name: 'Task prompt', exact: true }).fill('Hello');
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(page.locator('[data-event-type="agent.completed"]')).toBeVisible();
    const prompt = page.getByRole('textbox', { name: 'Follow-up prompt' });
    await prompt.fill('Keep this draft');
    await page.locator('.composer').evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(
        new File(['Reference for the current draft'], 'notes.md', { type: 'text/plain' }),
      );
      data.items.add(new File(['not supported'], 'archive.zip'));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }));
    });
    await expect(page.locator('.composer .attachment-chip')).toHaveCount(1);
    await expect(page.locator('.attachment-errors')).toContainText('Unsupported file type');
    const image = await imageFixture();
    await app.evaluate(({ clipboard, nativeImage }, base64) => {
      clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(base64, 'base64')));
    }, image.toString('base64'));
    await prompt.focus();
    await prompt.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
    await expect(page.locator('.composer .attachment-chip')).toHaveCount(2);
    const imageName = await page.locator('.composer .attachment-chip strong').last().innerText();
    await page.getByRole('button', { name: `Preview ${imageName}`, exact: true }).click();
    await expect(page.locator('.attachment-full-image')).toBeVisible();
    await page.getByRole('button', { name: 'Close preview', exact: true }).click();
    await page.getByRole('button', { name: `Remove ${imageName}`, exact: true }).click();
    await expect(page.locator('.composer .attachment-chip')).toHaveCount(1);
    await page.getByRole('button', { name: /New task/ }).click();
    await expect(page.getByRole('textbox', { name: 'Task prompt', exact: true })).toHaveValue('');
    await page.locator('.task-button').first().click();
    await expect(prompt).toHaveValue('Keep this draft');
    await expect(page.locator('.composer .attachment-chip')).toHaveCount(1);
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('real provider receives image/text without workspace; vision error preserves draft; Markdown and copy work', async () => {
  const bodies: unknown[] = [];
  const answer =
    '## Attachment analysis\n\n| Item | Value |\n| --- | --- |\n| Reference | received |\n\n```ts\nconst total = 42;\n```\n\n[Source](https://example.com/reference)\n\n![remote](https://example.com/pixel.png)';
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    bodies.push(JSON.parse(body));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const app = await launch();
  try {
    const page = await app.firstWindow();
    const url = `http://127.0.0.1:${address.port}/v1`;
    await page.evaluate(
      (url) =>
        window.hikari!.agent.configure({
          provider: 'compatible',
          model: 'fixture',
          apiKey: '',
          baseUrl: url,
        }),
      url,
    );
    const files = [path.join(directory, 'notes.md'), path.join(directory, 'design.png')];
    await writeFile(files[0]!, 'E2E_ATTACHMENT_REFERENCE');
    await writeFile(files[1]!, await imageFixture());
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: files,
      })) as typeof dialog.showOpenDialog;
    }, files);
    await page.getByRole('button', { name: 'Attach files or images', exact: true }).click();
    await expect(page.locator('.composer .attachment-chip')).toHaveCount(2);
    await page
      .getByRole('textbox', { name: 'Task prompt', exact: true })
      .fill('Explain these references');
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(page.locator('.global-error')).toContainText('Enable image support');
    await expect(page.locator('.composer .attachment-chip')).toHaveCount(2);
    await expect(page.getByRole('textbox', { name: 'Task prompt', exact: true })).toHaveValue(
      'Explain these references',
    );
    await page.evaluate(
      (url) =>
        window.hikari!.agent.configure({
          provider: 'compatible',
          model: 'fixture',
          apiKey: '',
          baseUrl: url,
          supportsVision: true,
        }),
      url,
    );
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(page.locator('[data-event-type="agent.completed"]')).toContainText(
      'Attachment analysis',
    );
    expect(JSON.stringify(bodies)).toContain('E2E_ATTACHMENT_REFERENCE');
    expect(JSON.stringify(bodies)).toContain('data:image/png;base64,');
    await expect(page.locator('.markdown-answer table')).toContainText('received');
    await page.getByRole('button', { name: 'Copy code', exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('const total = 42;\n');
    await page.getByRole('button', { name: 'Copy response', exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(answer);
    await expect(page.locator('.markdown-answer img')).toHaveCount(0);
    await expect(
      page.getByText('Conversation only · open a workspace', { exact: false }),
    ).toBeVisible();
    await expect(page.locator('.global-error')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/attachment-chat.png', fullPage: true });
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
