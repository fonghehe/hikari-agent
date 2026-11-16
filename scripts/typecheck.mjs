import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const compiler = require.resolve('typescript/bin/tsc');
const projects = [
  'apps/desktop/tsconfig.renderer.json',
  'apps/desktop/tsconfig.main.json',
  'tsconfig.node.json',
  'tsconfig.tooling.json',
];
for (const project of projects) {
  console.log(`Typechecking ${project}`);
  const result = spawnSync(process.execPath, [compiler, '--project', project], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
