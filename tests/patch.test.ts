import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileChangeService, contentHash } from '../packages/tools/src/patch';
import { ToolRegistry } from '../packages/agent-runtime/src';
import { registerFileTools } from '../packages/tools/src';
it('captures actual command edits for review and refuses to undo subsequent user changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-command-'));
  try {
    await writeFile(path.join(root, 'source.txt'), 'before');
    const changes = new FileChangeService(root, { emit() {} });
    const registry = new ToolRegistry();
    registerFileTools(registry, undefined, changes);
    const tool = registry.get('shell');
    const result = await tool.execute(
      tool.parse({
        command: process.execPath,
        args: ['-e', "require('fs').writeFileSync('source.txt','after')"],
      }),
      {
        taskId: 'capture',
        workspace: root,
        signal: new AbortController().signal,
        events: { emit() {} },
      },
    );
    expect(result.metadata?.exitCode).toBe(0);
    expect(changes.history[0]).toMatchObject({
      path: 'source.txt',
      before: 'before',
      after: 'after',
    });
    await writeFile(path.join(root, 'source.txt'), 'user edit');
    await expect(changes.undo(changes.history[0]!.id)).rejects.toThrow('subsequent changes');
    await writeFile(path.join(root, 'source.txt'), 'after');
    await changes.undo(changes.history[0]!.id);
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('before');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('previews, applies and undoes a patch without overwriting subsequent edits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-'));
  try {
    const file = path.join(root, 'a.txt');
    await writeFile(file, 'one\n');
    const changes = new FileChangeService(root, { emit() {} });
    const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+two\n';
    const preview = await changes.preview('a.txt', patch, contentHash('one\n'));
    expect(preview.after).toBe('two\n');
    expect(await readFile(file, 'utf8')).toBe('one\n');
    const change = await changes.apply('a.txt', patch, contentHash('one\n'));
    await writeFile(file, 'user edit\n');
    await expect(changes.undo(change.id)).rejects.toThrow('subsequent changes');
    await writeFile(file, 'two\n');
    await changes.undo(change.id);
    expect(await readFile(file, 'utf8')).toBe('one\n');
    await expect(changes.apply('a.txt', patch, 'old')).rejects.toThrow('File changed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('requires a preview of the exact patch before applying', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-preview-'));
  try {
    await writeFile(path.join(root, 'a.txt'), 'one\n');
    const changes = new FileChangeService(root, { emit() {} });
    await expect(
      changes.apply(
        'a.txt',
        '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n',
        contentHash('one\n'),
      ),
    ).rejects.toThrow('Preview this exact patch');
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('one\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('records large and binary changes without false deletions and refuses unavailable undo', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-large-'));
  try {
    const changes = new FileChangeService(root, { emit() {} });
    await writeFile(path.join(root, 'growing.txt'), 'small');
    await writeFile(path.join(root, 'large.txt'), 'a'.repeat(2100000));
    await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
    const before = await changes.snapshotExternal();
    await writeFile(path.join(root, 'growing.txt'), 'b'.repeat(2100000));
    await writeFile(path.join(root, 'large.txt'), 'c'.repeat(2100000));
    await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 3]));
    await changes.recordExternal(before);
    expect(changes.history).toHaveLength(3);
    for (const change of changes.history) {
      expect(change).toMatchObject({ exists: true, reviewable: false });
      expect(change.hash).not.toBeNull();
      await expect(changes.undo(change.id)).rejects.toThrow('external review');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
