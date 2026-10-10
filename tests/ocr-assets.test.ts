import { it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { prepareAttachment } from '../apps/desktop/src/main/attachments';
import { imageFixture } from './fixtures/attachment-files';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: vi.fn(),
}));

it.each(['eng', 'chi_sim', 'jpn'])(
  'rejects missing %s OCR data before worker initialization can hang',
  async (language) => {
    vi.mocked(existsSync).mockImplementation(
      (file) => !String(file).endsWith(`${language}.traineddata.gz`),
    );
    await expect(
      prepareAttachment({ name: 'image.png', bytes: await imageFixture() }),
    ).rejects.toThrow(`Missing local OCR data: ${language}.traineddata.gz`);
  },
);
