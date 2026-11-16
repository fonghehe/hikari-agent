import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repositoryRoot } from './lib/artifacts.mjs';

const scopes = {
  build: [
    'apps/desktop/dist',
    'apps/cli/dist',
    'apps/server/dist',
    'docs/.vitepress/dist',
    '.artifacts/package',
  ],
  reports: ['.artifacts/test-results', '.artifacts/playwright-report', '.artifacts/coverage'],
  cache: ['.turbo', '.cache', 'docs/.vitepress/cache'],
};

// Exact allowlist only. Releases, dependencies, runtime data and instructions are never targets.
export async function cleanupTargets(root, scope) {
  const entries = scopes[scope];
  if (!entries) throw new Error('Choose build, reports or cache');
  const targets = [];
  for (const entry of entries) {
    let current = path.resolve(root);
    for (const segment of entry.split('/')) {
      current = path.join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error(`Refusing cleanup through a symbolic link: ${current}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    targets.push(current);
  }
  return targets;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [scope = 'build', ...flags] = process.argv.slice(2);
  if (flags.some((flag) => flag !== '--apply')) throw new Error('Supported option: --apply');
  const targets = await cleanupTargets(repositoryRoot, scope);
  const apply = flags.includes('--apply');
  for (const target of targets) {
    console.log(`${apply ? 'Remove' : 'Would remove'} ${path.relative(repositoryRoot, target)}`);
    if (apply) await rm(target, { recursive: true, force: true });
  }
  if (!apply) console.log('Dry run. Add --apply to remove these generated files.');
}
