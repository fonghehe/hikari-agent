import { expect, it } from 'vitest';
import { prepareAttachment } from '../../apps/desktop/src/main/attachments/attachments';

it('keeps a bounded fenced block intact and labels chunks with their heading', async () => {
  const code = '```typescript\n' + 'const total = 42;\n'.repeat(30) + '```';
  const text =
    '# Billing\n\n' +
    'Introduction. '.repeat(140) +
    '\n\n' +
    code +
    '\n\n# Shipping\n\nDelivered tomorrow.';
  const value = await prepareAttachment({ name: 'guide.md', bytes: Buffer.from(text) });
  expect(value.chunks!.some((chunk) => chunk.text.includes(code))).toBe(true);
  expect(
    value.chunks!.find((chunk) => chunk.text.includes('Delivered tomorrow.'))?.label,
  ).toContain('Shipping');
});

it('retains overlapping evidence and exact source offsets without broken Unicode', async () => {
  const text = '# Policy\n\n' + '退款需要原始收据。😀'.repeat(650);
  const value = await prepareAttachment({ name: 'policy.md', bytes: Buffer.from(text) });
  const chunks = value.chunks! as {
    text: string;
    start?: number;
    end?: number;
    chunkId?: string;
  }[];
  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks[1]!.start).toBeLessThan(chunks[0]!.end!);
  for (const chunk of chunks) {
    expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text);
    expect(chunk.text).not.toMatch(
      /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u,
    );
    expect(chunk.chunkId).toMatch(/^[a-f0-9]{64}$/);
  }
});

it('bounds repeated heading metadata even for a pathological long heading', async () => {
  const value = await prepareAttachment({
    name: 'large.md',
    bytes: Buffer.from('# ' + 'Heading'.repeat(15000)),
  });
  expect(
    value.chunks!.every(
      (chunk) => chunk.label.length <= 512 && (chunk.heading?.length ?? 0) <= 200,
    ),
  ).toBe(true);
});
