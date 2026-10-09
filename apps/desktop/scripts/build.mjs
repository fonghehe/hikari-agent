await import('../../../scripts/prepare-native.mjs');
await import('./icons.mjs');
await import('./ocr-assets.mjs');
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
await build({
  entryPoints: { index: 'src/main/index.ts', 'attachment-worker': 'src/main/attachment-worker.ts' },
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
await viteBuild();
