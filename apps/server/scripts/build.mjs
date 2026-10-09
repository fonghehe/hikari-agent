import { build } from 'esbuild';
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['fastify', '@fastify/*', 'ioredis', 'pg', 'drizzle-orm', 'drizzle-orm/*'],
  sourcemap: true,
});
