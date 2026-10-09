import path from 'node:path';
import { readFile, stat, realpath } from 'node:fs/promises';
import { LogicalSandboxProvider } from '@hikari/sandbox';
import { searchTerms } from '@hikari/agent-core';
const sandbox = new LogicalSandboxProvider();
export async function projectInstructions(root: string, file = '.') {
  root = await realpath(root);
  const target = await sandbox.resolve(root, file);
  const parts = path
    .relative(root, path.dirname(target === root ? path.join(root, '_') : target))
    .split(path.sep)
    .filter(Boolean);
  const directories = ['.', ...parts.map((_, index) => parts.slice(0, index + 1).join(path.sep))];
  const rules: { path: string; text: string; truncated: boolean }[] = [];
  for (const directory of directories)
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const relative = path.join(directory, name);
      try {
        const filename = await sandbox.resolve(root, relative);
        if ((await stat(filename)).size > 128000) {
          rules.push({
            path: relative,
            text: '[Oversized project instructions; use read_file for focused sections.]',
            truncated: true,
          });
          continue;
        }
        const text = await readFile(filename, 'utf8');
        rules.push({ path: relative, text: text.slice(0, 6000), truncated: text.length > 6000 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  return rules;
}
export function relevantFiles(files: string[], query: string, limit = 120) {
  const terms = searchTerms(query);
  return files
    .map((file) => ({
      file,
      score:
        terms.reduce(
          (n, term) => n + (file.normalize('NFKC').toLowerCase().includes(term) ? 4 : 0),
          0,
        ) +
        (/^(package.json|README.md|AGENTS.md|CLAUDE.md|pyproject.toml|go.mod|pom.xml|Cargo.toml)$/.test(
          file,
        )
          ? 5
          : 0) +
        (/^(src|app|apps|packages)\//.test(file) ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit)
    .map((item) => item.file);
}
