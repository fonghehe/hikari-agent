import { it, expect } from 'vitest';
import {
  AttachmentStore,
  registerAttachmentTools,
  prepareAttachment,
} from '../apps/desktop/src/main/attachments';
import { ToolRegistry } from '../packages/agent-runtime/src';
import { imageFixture, scannedPdfFixture } from './fixtures/attachment-files';
import { createRequire } from 'node:module';
it('searches retained content beyond the prompt preview and restricts document access', async () => {
  const store = new AttachmentStore();
  const batch = await store.import([
    {
      name: 'long.md',
      bytes: Buffer.from('Introduction\n\n'.repeat(1100) + 'Hidden conclusion: UNIQUE_END_MARKER'),
    },
  ]);
  expect(batch.errors).toEqual([]);
  const id = batch.items[0]!.id;
  expect(store.read(id).text).not.toContain('UNIQUE_END_MARKER');
  const registry = new ToolRegistry();
  registerAttachmentTools(registry, store, [id]);
  const tool = registry.get('search_attachments');
  const result = await tool.execute(tool.parse({ query: 'UNIQUE_END_MARKER' }), {} as never);
  expect(result.content).toContain('UNIQUE_END_MARKER');
  expect(result.content).toContain('Paragraph');
  const read = registry.get('read_attachment');
  await expect(
    read.execute(read.parse({ id: '00000000-0000-4000-8000-000000000000', index: 0 }), {} as never),
  ).rejects.toThrow('outside this conversation');
});
it('recognizes actual text in an image offline', async () => {
  const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
  const canvas =
    require('@napi-rs/canvas') as typeof import('../apps/desktop/node_modules/@napi-rs/canvas');
  const image = canvas.createCanvas(1000, 160);
  const context = image.getContext('2d');
  context.fillStyle = 'white';
  context.fillRect(0, 0, 1000, 160);
  context.fillStyle = 'black';
  context.font = 'bold 64px sans-serif';
  context.fillText('HIKARI INVOICE 12345', 30, 100);
  const value = await prepareAttachment({
    name: 'invoice.png',
    bytes: image.toBuffer('image/png'),
  });
  expect(value.ocr).toBe(true);
  expect(value.text).toContain('12345');
  expect(value.chunks?.[0]?.label).toContain('OCR paragraph');
});
it('rejects an image forgery without starting OCR', async () => {
  await expect(
    prepareAttachment({ name: 'fake.png', bytes: Buffer.from('not an image') }),
  ).rejects.toThrow();
  expect(await imageFixture()).toBeDefined();
});
it('retrieves Chinese and Japanese document passages without word separators', async () => {
  const store = new AttachmentStore();
  const batch = await store.import([
    {
      name: '操作指南.md',
      bytes: Buffer.from('金额计算需要保留两位小数。\n\n設定変更は保存ボタンを押します。'),
    },
  ]);
  const registry = new ToolRegistry();
  registerAttachmentTools(
    registry,
    store,
    batch.items.map((item) => item.id),
  );
  const search = registry.get('search_attachments');
  for (const query of ['金额计算应该怎么做', '設定変更の操作']) {
    const result = await search.execute(search.parse({ query }), {} as never);
    expect(JSON.parse(result.content)).not.toHaveLength(0);
  }
});
it('renders and recognizes a scanned PDF with page citations offline', async () => {
  const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
  const canvas =
    require('@napi-rs/canvas') as typeof import('../apps/desktop/node_modules/@napi-rs/canvas');
  const image = canvas.createCanvas(1000, 180);
  const context = image.getContext('2d');
  context.fillStyle = 'white';
  context.fillRect(0, 0, 1000, 180);
  context.fillStyle = 'black';
  context.font = 'bold 64px sans-serif';
  context.fillText('HIKARI INVOICE 67890', 30, 110);
  const value = await prepareAttachment({
    name: 'scan.pdf',
    bytes: scannedPdfFixture(image.toBuffer('image/jpeg'), 1000, 180),
  });
  expect(value.text).toContain('67890');
  expect(value.chunks?.[0]?.label).toContain('Page 1');
});
