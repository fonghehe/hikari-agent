import { mkdir, copyFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(new URL('../package.json', import.meta.url));
const directory = fileURLToPath(new URL('../resources/ocr/', import.meta.url));
await mkdir(directory, { recursive: true });
for (const language of ['eng', 'chi_sim', 'jpn']) {
  const root = path.dirname(require.resolve(`@tesseract.js-data/${language}/package.json`));
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  try {
    await copyFile(path.join(root, '4.0.0_best_int', `${language}.traineddata.gz`), temporary);
    await rename(temporary, path.join(directory, `${language}.traineddata.gz`));
  } finally {
    await rm(temporary, { force: true });
  }
}
