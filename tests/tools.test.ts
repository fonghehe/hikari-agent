import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LogicalSandboxProvider } from '../packages/sandbox/src';
import { runProcess } from '../packages/tools/src/process';
it('rejects nonexistent paths beneath escaping symlinks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-'));
  try {
    await symlink(
      tmpdir(),
      path.join(root, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const sandbox = new LogicalSandboxProvider();
    await expect(sandbox.resolve(root, 'link/new.txt', true)).rejects.toThrow('outside workspace');
    await expect(sandbox.resolve(root, '.git/config', true)).rejects.toThrow('protected');
    await expect(sandbox.resolve(root, '.agent/runs/private.json')).rejects.toThrow('protected');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('executes argument arrays without shell interpolation and enforces limits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-'));
  try {
    await writeFile(path.join(root, 'test.js'), 'console.log(process.argv[2])');
    const options = { cwd: root, env: {}, signal: new AbortController().signal };
    expect(
      (await runProcess(process.execPath, ['test.js', '$(touch pwned)'], options)).output.trim(),
    ).toBe('$(touch pwned)');
    await expect(
      runProcess(process.execPath, ['-e', 'setInterval(()=>{},100)'], {
        ...options,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('timed out');
    await expect(
      runProcess(process.execPath, ['-e', 'console.log("x".repeat(10000))'], {
        ...options,
        maxOutput: 100,
      }),
    ).rejects.toThrow('output limit');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('paginates large reads as complete JSON observations with a full-file hash', async () => {
  const { ToolRegistry } = await import('../packages/agent-runtime/src');
  const { registerFileTools, hash } = await import('../packages/tools/src');
  const root = await mkdtemp(path.join(tmpdir(), 'forge-read-'));
  try {
    const original = '"\\\n'.repeat(10000);
    await writeFile(path.join(root, 'large.txt'), original);
    const tools = new ToolRegistry();
    registerFileTools(tools);
    const tool = tools.get('read_file');
    let offset = 0;
    let reconstructed = '';
    do {
      const result = await tool.execute(tool.parse({ path: 'large.txt', offset }), {
        taskId: 'read',
        workspace: root,
        signal: new AbortController().signal,
        events: { emit() {} },
      });
      expect(result.content.length).toBeLessThanOrEqual(18000);
      const page = JSON.parse(result.content) as {
        content: string;
        hash: string;
        nextOffset: number | null;
      };
      expect(page.hash).toBe(hash(original));
      reconstructed += page.content;
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    } while (offset < original.length);
    expect(reconstructed).toBe(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('never lets an include glob override repository metadata and dependency exclusions', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { RepositoryIndexer } = await import('../packages/tools/src');
  const root = await mkdtemp(path.join(tmpdir(), 'forge-index-'));
  try {
    for (const directory of ['.git', '.agent', 'node_modules', 'src']) {
      await mkdir(path.join(root, directory));
      await writeFile(path.join(root, directory, 'fixture.ts'), 'fixture symbol');
    }
    const index = new RepositoryIndexer(root);
    expect(await index.findFiles('*')).toEqual(['src/fixture.ts']);
    expect(await index.findFiles('**/*.ts')).toEqual(['src/fixture.ts']);
    expect(await index.searchText('fixture', '**/*.ts')).not.toMatch(/\.git|\.agent|node_modules/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
