import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectInstructions, registerFileTools } from '../packages/tools/src';
import { ToolRegistry } from '../packages/agent-runtime/src';
it('loads applicable root/nested instructions, exposes symbols and resolves local module candidates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-map-'));
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'AGENTS.md'), 'Preserve the public API.');
    await writeFile(path.join(root, 'src', 'CLAUDE.md'), 'Test changes in src.');
    await writeFile(
      path.join(root, 'src', 'helper.ts'),
      'export function helper() { return 1; }\n',
    );
    await writeFile(
      path.join(root, 'src', 'main.ts'),
      "import { helper } from './helper';\nexport function main() { return helper(); }\n",
    );
    expect((await projectInstructions(root, 'src/main.ts')).map((rule) => rule.path)).toEqual([
      'AGENTS.md',
      'src/CLAUDE.md',
    ]);
    const registry = new ToolRegistry();
    registerFileTools(registry);
    const context = {
      taskId: 'fixture',
      workspace: root,
      signal: new AbortController().signal,
      events: { emit() {} },
    };
    const symbol = registry.get('find_symbol');
    expect((await symbol.execute(symbol.parse({ name: 'helper' }), context)).content).toContain(
      'export function helper',
    );
    const map = registry.get('repository_map');
    const result = JSON.parse(
      (await map.execute(map.parse({ query: 'main', limit: 10 }), context)).content,
    );
    expect(
      result.modules.find((item: { file: string }) => item.file === 'src/main.ts').dependencies[0]
        .candidates,
    ).toContain('src/helper.ts');
    const outside = await mkdtemp(path.join(tmpdir(), 'hikari-outside-'));
    try {
      await writeFile(path.join(outside, 'AGENTS.md'), 'outside');
      await symlink(outside, path.join(root, 'escape'));
      await expect(projectInstructions(root, 'escape/file.ts')).rejects.toThrow('outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
