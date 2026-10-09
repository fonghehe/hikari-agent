import { it, expect, describe } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileChangeService, contentHash } from '../packages/tools/src/patch';

const exists = (file: string) =>
  access(file)
    .then(() => true)
    .catch(() => false);

async function withRoot(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-multi-'));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const multiDiff = [
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1 +1 @@',
  '-one',
  '+ONE',
  '--- a/b.txt',
  '+++ b/renamed.txt',
  '--- a/c.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  '--- /dev/null',
  '+++ b/new/d.txt',
  '@@ -0,0 +1 @@',
  '+fresh',
].join('\n');

const allEntries = () => [
  { path: 'a.txt', expectedHash: contentHash('one\n') },
  { path: 'b.txt', expectedHash: contentHash('keep\n') },
  { path: 'c.txt', expectedHash: contentHash('gone\n') },
  { path: 'new/d.txt', expectedHash: null },
];

async function seedRoot(root: string) {
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  await writeFile(path.join(root, 'b.txt'), 'keep\n');
  await writeFile(path.join(root, 'c.txt'), 'gone\n');
}

it('applies a multi-file patch that creates, modifies, renames and deletes', async () => {
  await withRoot(async (root) => {
    await seedRoot(root);
    const changes = new FileChangeService(root, { emit() {} });
    const entries = allEntries();
    const preview = await changes.previewFiles(entries, multiDiff);
    expect(preview.files.map((f) => [f.action, f.path])).toEqual([
      ['modify', 'a.txt'],
      ['rename', 'renamed.txt'],
      ['delete', 'c.txt'],
      ['create', 'new/d.txt'],
    ]);
    expect(preview.files[1]!.oldPath).toBe('b.txt');
    expect(preview.files[2]!.hash).toBeNull();
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('one\n');
    const applied = await changes.applyFiles(entries, multiDiff);
    expect(applied.files).toHaveLength(4);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('ONE\n');
    expect(await readFile(path.join(root, 'renamed.txt'), 'utf8')).toBe('keep\n');
    expect(await exists(path.join(root, 'b.txt'))).toBe(false);
    expect(await exists(path.join(root, 'c.txt'))).toBe(false);
    expect(await readFile(path.join(root, 'new/d.txt'), 'utf8')).toBe('fresh\n');
    expect(changes.history.map((c) => c.path)).toEqual([
      'a.txt',
      'renamed.txt',
      'c.txt',
      'new/d.txt',
    ]);
  });
});

it('rejects a multi-file apply without an exact preview', async () => {
  await withRoot(async (root) => {
    await seedRoot(root);
    const changes = new FileChangeService(root, { emit() {} });
    await expect(changes.applyFiles(allEntries(), multiDiff)).rejects.toThrow(
      'Preview this exact patch',
    );
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('one\n');
    expect(await exists(path.join(root, 'new/d.txt'))).toBe(false);
  });
});

it('leaves every file untouched when one file went stale between preview and apply', async () => {
  await withRoot(async (root) => {
    await seedRoot(root);
    const changes = new FileChangeService(root, { emit() {} });
    await changes.previewFiles(allEntries(), multiDiff);
    await writeFile(path.join(root, 'c.txt'), 'user edit\n');
    await expect(changes.applyFiles(allEntries(), multiDiff)).rejects.toThrow('File changed');
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('one\n');
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('keep\n');
    expect(await readFile(path.join(root, 'c.txt'), 'utf8')).toBe('user edit\n');
    expect(changes.history).toHaveLength(0);
  });
});

it('rolls back already applied operations when a later operation fails mid-flight', async () => {
  await withRoot(async (root) => {
    await seedRoot(root);
    const changes = new FileChangeService(root, { emit() {} });
    await changes.previewFiles(allEntries(), multiDiff);
    const service = changes as unknown as Record<string, unknown>;
    const original = (
      Object.getPrototypeOf(changes) as {
        performOp: (op: unknown, journal: Array<() => Promise<void>>) => Promise<void>;
      }
    ).performOp;
    let calls = 0;
    service.performOp = async (op: unknown, journal: Array<() => Promise<void>>) => {
      calls += 1;
      if (calls === 2) throw new Error('injected failure');
      return original.call(changes, op, journal);
    };
    try {
      await expect(changes.applyFiles(allEntries(), multiDiff)).rejects.toThrow('injected failure');
    } finally {
      delete service.performOp;
    }
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('one\n');
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('keep\n');
    expect(await exists(path.join(root, 'renamed.txt'))).toBe(false);
    expect(await readFile(path.join(root, 'c.txt'), 'utf8')).toBe('gone\n');
    expect(changes.history).toHaveLength(0);
  });
});

it('undoes renames with edits by restoring the old path and content', async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, 'b.txt'), 'old\n');
    const changes = new FileChangeService(root, { emit() {} });
    const diff = ['--- a/b.txt', '+++ b/renamed.txt', '@@ -1 +1 @@', '-old', '+new'].join('\n');
    const entries = [{ path: 'b.txt', expectedHash: contentHash('old\n') }];
    await changes.previewFiles(entries, diff);
    const applied = await changes.applyFiles(entries, diff);
    expect(await readFile(path.join(root, 'renamed.txt'), 'utf8')).toBe('new\n');
    await changes.undo(applied.changes[0]!.id);
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('old\n');
    expect(await exists(path.join(root, 'renamed.txt'))).toBe(false);
  });
});

it('undoes multi-file deletions and creations individually', async () => {
  await withRoot(async (root) => {
    await seedRoot(root);
    const changes = new FileChangeService(root, { emit() {} });
    await changes.previewFiles(allEntries(), multiDiff);
    const applied = await changes.applyFiles(allEntries(), multiDiff);
    expect(await exists(path.join(root, 'c.txt'))).toBe(false);
    const [modify, rename, remove, create] = applied.changes;
    if (!modify || !rename || !remove || !create) throw new Error('Expected four changes');
    expect([modify.path, rename.path, remove.path, create.path]).toEqual([
      'a.txt',
      'renamed.txt',
      'c.txt',
      'new/d.txt',
    ]);
    await changes.undo(create.id);
    expect(await exists(path.join(root, 'new/d.txt'))).toBe(false);
    await changes.undo(remove.id);
    expect(await readFile(path.join(root, 'c.txt'), 'utf8')).toBe('gone\n');
    await changes.undo(rename.id);
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('keep\n');
    expect(await exists(path.join(root, 'renamed.txt'))).toBe(false);
    await changes.undo(modify.id);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('one\n');
  });
});

it('rejects overlapping patch sections and mismatched declarations', async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, 'a.txt'), 'one\n');
    const changes = new FileChangeService(root, { emit() {} });
    const overlapping = [
      '--- a/a.txt',
      '+++ b/b.txt',
      '--- /dev/null',
      '+++ b/b.txt',
      '@@ -0,0 +1 @@',
      '+dupe',
    ].join('\n');
    await expect(
      changes.previewFiles(
        [
          { path: 'a.txt', expectedHash: contentHash('one\n') },
          { path: 'b.txt', expectedHash: null },
        ],
        overlapping,
      ),
    ).rejects.toThrow('overlap');
    await expect(
      changes.previewFiles(
        [
          { path: 'a.txt', expectedHash: contentHash('one\n') },
          { path: 'missing.txt', expectedHash: null },
        ],
        '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+ONE\n',
      ),
    ).rejects.toThrow('missing.txt');
    await expect(
      changes.previewFiles([{ path: 'a.txt', expectedHash: contentHash('one\n') }], ''),
    ).rejects.toThrow('no file sections');
  });
});

it('rejects renames onto existing files and creations of existing files', async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, 'b.txt'), 'old\n');
    await writeFile(path.join(root, 'taken.txt'), 'busy\n');
    const changes = new FileChangeService(root, { emit() {} });
    const rename = '--- a/b.txt\n+++ b/taken.txt\n';
    await expect(
      changes.previewFiles([{ path: 'b.txt', expectedHash: contentHash('old\n') }], rename),
    ).rejects.toThrow('already exists');
    const create = ['--- /dev/null', '+++ b/taken.txt', '@@ -0,0 +1 @@', '+fresh'].join('\n');
    await expect(
      changes.previewFiles([{ path: 'taken.txt', expectedHash: null }], create),
    ).rejects.toThrow('already exists');
  });
});

describe('legacy single-file API keeps its guarantees', () => {
  it('still rejects multi-file, rename and delete diffs', async () => {
    await withRoot(async (root) => {
      await writeFile(path.join(root, 'a.txt'), 'one\n');
      await writeFile(path.join(root, 'b.txt'), 'keep\n');
      const changes = new FileChangeService(root, { emit() {} });
      await expect(changes.preview('a.txt', multiDiff, contentHash('one\n'))).rejects.toThrow(
        'One file per patch',
      );
      await expect(
        changes.preview('a.txt', '--- a/a.txt\n+++ b/moved.txt\n', contentHash('one\n')),
      ).rejects.toThrow('renames and deletions are not supported');
    });
  });
});

it('restores edited rename content when a later operation fails', async () => {
  await withRoot(async (root) => {
    await seedRoot(root);
    const diff = multiDiff.replace(
      '+++ b/renamed.txt',
      '+++ b/renamed.txt\n@@ -1 +1 @@\n-keep\n+changed',
    );
    const changes = new FileChangeService(root, { emit() {} });
    await changes.previewFiles(allEntries(), diff);
    const service = changes as unknown as {
      performOp(op: unknown, journal: Array<() => Promise<void>>): Promise<void>;
    };
    const original = service.performOp.bind(changes);
    let calls = 0;
    service.performOp = async (op, journal) => {
      if (++calls === 3) throw new Error('later failure');
      return original(op, journal);
    };
    await expect(changes.applyFiles(allEntries(), diff)).rejects.toThrow('later failure');
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('one\n');
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('keep\n');
    expect(await exists(path.join(root, 'renamed.txt'))).toBe(false);
    expect(changes.history).toHaveLength(0);
  });
});

it('journals a rename before its subsequent content replacement can fail', async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, 'b.txt'), 'keep\n');
    const diff = '--- a/b.txt\n+++ b/renamed.txt\n@@ -1 +1 @@\n-keep\n+changed\n';
    const entries = [{ path: 'b.txt', expectedHash: contentHash('keep\n') }];
    const changes = new FileChangeService(root, { emit() {} });
    await changes.previewFiles(entries, diff);
    const service = changes as unknown as {
      safeReplace(target: string, after: string, hash: string): Promise<void>;
    };
    service.safeReplace = async () => {
      throw new Error('replacement failure');
    };
    await expect(changes.applyFiles(entries, diff)).rejects.toThrow('replacement failure');
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('keep\n');
    expect(await exists(path.join(root, 'renamed.txt'))).toBe(false);
    expect(changes.history).toHaveLength(0);
  });
});

it('checks deletion freshness immediately before mutation and preserves external edits', async () => {
  await withRoot(async (root) => {
    await seedRoot(root);
    const changes = new FileChangeService(root, { emit() {} });
    await changes.previewFiles(allEntries(), multiDiff);
    const service = changes as unknown as {
      performOp(op: unknown, journal: Array<() => Promise<void>>): Promise<void>;
    };
    const original = service.performOp.bind(changes);
    let calls = 0;
    service.performOp = async (op, journal) => {
      if (++calls === 3) await writeFile(path.join(root, 'c.txt'), 'external edit\n');
      return original(op, journal);
    };
    await expect(changes.applyFiles(allEntries(), multiDiff)).rejects.toThrow('File changed');
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('one\n');
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('keep\n');
    expect(await readFile(path.join(root, 'c.txt'), 'utf8')).toBe('external edit\n');
    expect(changes.history).toHaveLength(0);
  });
});

it('rejects duplicate declarations and nonexistent modification sources', async () => {
  await withRoot(async (root) => {
    const changes = new FileChangeService(root, { emit() {} });
    const diff = '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n';
    const entry = { path: 'new.txt', expectedHash: null };
    await expect(changes.previewFiles([entry, entry], diff)).rejects.toThrow('unique');
    await expect(changes.previewFiles([entry], '--- a/new.txt\n+++ b/new.txt\n')).rejects.toThrow(
      'no longer exists',
    );
  });
});

it('preserves executable permissions when undoing a deletion', async () => {
  if (process.platform === 'win32') return;
  await withRoot(async (root) => {
    const { chmod, stat } = await import('node:fs/promises');
    const file = path.join(root, 'script.sh');
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o755);
    const changes = new FileChangeService(root, { emit() {} });
    const entries = [{ path: 'script.sh', expectedHash: contentHash('#!/bin/sh\n') }];
    const diff = '--- a/script.sh\n+++ /dev/null\n@@ -1 +0,0 @@\n-#!/bin/sh\n';
    await changes.previewFiles(entries, diff);
    const applied = await changes.applyFiles(entries, diff);
    await changes.undo(applied.changes[0]!.id);
    expect((await stat(file)).mode & 0o777).toBe(0o755);
  });
});
