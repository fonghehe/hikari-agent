import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const repository = process.env.GITHUB_REPOSITORY;
if (!repository || !/^[-\w.]+\/[-\w.]+$/.test(repository))
  throw new Error('Release builds require the actual GITHUB_REPOSITORY');
const [owner, repo] = repository.split('/');
const version = process.env.GITHUB_REF_NAME?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
  throw new Error('Use a semantic version tag such as v0.1.0');
if (
  ['darwin', 'win32'].includes(process.platform) &&
  (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD)
)
  throw new Error(
    'Signed releases require CSC_LINK and CSC_KEY_PASSWORD; unsigned installers are not published',
  );
if (
  process.platform === 'darwin' &&
  (!process.env.CSC_NAME ||
    !process.env.APPLE_ID ||
    !process.env.APPLE_APP_SPECIFIC_PASSWORD ||
    !process.env.APPLE_TEAM_ID)
)
  throw new Error('macOS releases require Developer ID identity and notarization credentials');
const root = fileURLToPath(new URL('..', import.meta.url));
const run = (command, args, cwd = root) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
const desktop = path.join(root, 'apps/desktop');
const manifest = path.join(desktop, 'package.json');
const original = await readFile(manifest, 'utf8');
const data = JSON.parse(original);
data.version = version;
await writeFile(manifest, JSON.stringify(data, null, 2) + '\n');
const config = path.join(desktop, 'release.config.json');
try {
  await run('node', ['scripts/build.mjs'], desktop);
  await run('node', ['scripts/check-native.mjs'], desktop);
  await run('node', ['scripts/browser-assets.mjs'], desktop);
  await writeFile(
    config,
    JSON.stringify({
      extends: './electron-builder.yml',
      publish: [{ provider: 'github', owner, repo, releaseType: 'draft' }],
      mac: { identity: process.env.CSC_NAME, notarize: true },
      forceCodeSigning: ['darwin', 'win32'].includes(process.platform),
    }),
  );
  await run(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'electron-builder', '--config', config, '--publish', 'always'],
    desktop,
  );
} finally {
  await writeFile(manifest, original);
  await rm(config, { force: true });
}
