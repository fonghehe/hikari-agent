import { desktopStage, desktopRelease } from '../../../scripts/lib/artifacts.mjs';
import { build } from 'electron-builder';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const electron = JSON.parse(
  await readFile(path.join(root, 'node_modules/electron/package.json'), 'utf8'),
);
const report = JSON.parse(await readFile(path.join(root, 'dist/package-report.json'), 'utf8'));
const releaseIndex = process.argv.indexOf('--release-config');
if (releaseIndex >= 0 && process.env.HIKARI_RELEASE_AUTHORIZED !== '1')
  throw new Error('Publication must use the validated release-desktop.mjs entry point');
const release =
  releaseIndex >= 0 ? JSON.parse(await readFile(process.argv[releaseIndex + 1], 'utf8')) : {};
// Build from the materialized production app, so workspace lockfile discovery cannot re-add dev/UI dependencies.
await build({
  projectDir: desktopStage,
  dir: process.argv.includes('--dir'),
  publish: releaseIndex >= 0 ? 'always' : 'never',
  config: {
    extends: path.join(root, 'electron-builder.yml'),
    electronVersion: electron.version,
    electronDist: path.join(root, 'node_modules/electron/dist'),
    directories: {
      app: '.',
      output: desktopRelease,
      buildResources: path.join(root, 'resources'),
    },
    mac: {
      icon: path.join(root, 'resources/icons/hikari.icns'),
      entitlements: path.join(root, 'resources/entitlements.mac.plist'),
      entitlementsInherit: path.join(root, 'resources/entitlements.mac.plist'),
      ...release.mac,
    },
    win: { icon: path.join(root, 'resources/icons/hikari.ico') },
    linux: { icon: path.join(root, 'resources/icons/hikari.png') },
    dmg: { icon: path.join(root, 'resources/icons/hikari.icns') },
    ...(release.publish ? { publish: release.publish } : {}),
    ...(release.forceCodeSigning ? { forceCodeSigning: true } : {}),
    asarUnpack: [
      '**/*.node',
      '**/node-pty/**',
      '**/pdfjs-dist/**',
      '**/@img/**',
      '**/@napi-rs/**',
      '**/sharp/**',
      ...report.workerPackages.map((name) => `**/node_modules/${name}/**`),
    ],
  },
});
