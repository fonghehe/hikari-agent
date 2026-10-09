import { chromium } from 'playwright';
import { mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const executable = chromium.executablePath();
if (!existsSync(executable))
  throw new Error(
    'Install the release browser first: pnpm --filter @hikari/desktop exec playwright install chromium',
  );
let root = path.dirname(executable);
while (!/^chromium[-_]/.test(path.basename(root))) {
  const parent = path.dirname(root);
  if (parent === root) throw new Error('Unrecognized Chromium installation');
  root = parent;
}
const target = fileURLToPath(new URL('../resources/browser/', import.meta.url));
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(root, target, { recursive: true, verbatimSymlinks: true });
await writeFile(
  path.join(target, 'manifest.json'),
  JSON.stringify({ executable: path.relative(root, executable) }),
);
