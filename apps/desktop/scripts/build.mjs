await import('../../../scripts/prepare-native.mjs');
await import('./icons.mjs');
await import('./ocr-assets.mjs');
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
const main = await build({
  metafile: true,
  minify: true,
  keepNames: true,
  entryPoints: {
    index: 'src/main/index.ts',
    'attachment-worker': 'src/main/attachments/attachment-worker.ts',
  },
  outdir: 'dist/main',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: [
    'electron',
    'sharp',
    'unpdf',
    'pdfjs-dist/*',
    '@napi-rs/canvas',
    'tesseract.js',
    'electron-updater',
    'mammoth',
    'node-pty',
    'playwright',
    '@modelcontextprotocol/sdk/*',
    'pg',
    'drizzle-orm',
    'drizzle-orm/*',
  ],
  sourcemap: true,
});
await build({
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
const native = new Set(builtinModules);
const names = new Set(
  Object.values(main.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter(
      (item) =>
        item.external &&
        !item.path.startsWith('node:') &&
        !native.has(item.path) &&
        item.path !== 'electron',
    )
    .map(({ path }) =>
      path.startsWith('@') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0],
    ),
);
await writeFile('dist/runtime-dependencies.json', JSON.stringify([...names].sort(), null, 2));
await viteBuild();
