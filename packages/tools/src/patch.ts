import { readFile, writeFile, mkdir, unlink, rename, stat, readdir, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { applyPatch, parsePatch, createTwoFilesPatch } from 'diff';
import { AgentError, type EventSink } from '@hikari/agent-core';
import { LogicalSandboxProvider } from '@hikari/sandbox';
export const contentHash = (text: string) => createHash('sha256').update(text).digest('hex');
export type FileAction = 'create' | 'modify' | 'delete' | 'rename';
export interface FileEntry {
  /** Current on-disk path (the old path for renames, the final path for new files). */
  path: string;
  /** SHA-256 of the current content, or null when the file must not exist yet. */
  expectedHash: string | null;
}
export interface FileSummary {
  path: string;
  oldPath: string | null;
  action: FileAction;
  after: string | null;
  hash: string | null;
  diff: string;
}
interface PlannedOp {
  entry: FileEntry;
  oldPath: string;
  newPath: string;
  action: FileAction;
  before: string | null;
  beforeMode?: number;
  after: string | null;
}
export interface Change {
  id: string;
  /** Final path after the change (the new path for renames). */
  path: string;
  /** Previous path when this change renamed the file. */
  oldPath: string | null;
  before: string | null;
  beforeMode?: number;
  afterMode?: number;
  reviewable?: boolean;
  binary?: boolean;
  exists?: boolean;
  beforeSize?: number;
  afterSize?: number;
  /** Resulting content, or null when this change deleted the file. */
  after: string | null;
  /** Hash of the final content, or null when the final state is an absent file. */
  hash: string | null;
  accepted: boolean;
  undone: boolean;
}
const normalizeHeader = (name: string | undefined) => {
  if (!name) throw new AgentError('PATCH_PATH', 'Patch section is missing a file name');
  return name.replace(/^[ab]\//, '');
};
export class FileChangeService {
  readonly history: Change[] = [];
  private previews = new Set<string>();
  private externalHashes = new Map<string, { signature: string; hash: string }>();
  constructor(
    readonly root: string,
    private events: EventSink,
    private sandbox = new LogicalSandboxProvider(),
  ) {}
  private async read(file: string) {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async snapshotExternal(signal?: AbortSignal) {
    const files = new Map<
      string,
      { content: string | null; hash: string; mode: number; size: number; binary: boolean }
    >();
    let bytes = 0;
    const hashes = new Map<string, { signature: string; hash: string }>();
    const walk = async (directory: string, relative = '') => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        signal?.throwIfAborted();
        if (
          [
            '.git',
            '.agent',
            'node_modules',
            '.turbo',
            'dist',
            'build',
            'coverage',
            'release',
            'test-results',
            'playwright-report',
            '.pytest_cache',
            '.cache',
            '__pycache__',
          ].includes(entry.name) ||
          entry.isSymbolicLink()
        )
          continue;
        const filename = path.join(directory, entry.name),
          name = path.join(relative, entry.name);
        if (entry.isDirectory()) {
          if (name.split(path.sep).length < 20) await walk(filename, name);
          continue;
        }
        if (!entry.isFile()) continue;
        if (files.size >= 100000)
          throw new AgentError(
            'CHANGE_CAPTURE_LIMIT',
            'Workspace exceeds 100,000 files for command tracking; use focused file tools.',
          );
        const info = await stat(filename);
        const signature = JSON.stringify([
          info.dev,
          info.ino,
          info.size,
          info.mtimeMs,
          info.ctimeMs,
        ]);
        const cached = this.externalHashes.get(name);
        // Hash every file, but keep bounded UTF-8 text for in-app review/undo.
        // Crossing the text size limit must never look like a deletion.
        const digest = createHash('sha256');
        let buffer: Buffer | undefined;
        if (info.size <= 2000000 && bytes + info.size <= 40000000) {
          buffer = await readFile(filename);
          bytes += buffer.length;
          digest.update(buffer);
        } else if (cached?.signature !== signature) {
          for await (const chunk of createReadStream(filename)) {
            signal?.throwIfAborted();
            digest.update(chunk);
          }
        }
        const stable = await stat(filename);
        if (
          JSON.stringify([stable.dev, stable.ino, stable.size, stable.mtimeMs, stable.ctimeMs]) !==
          signature
        )
          throw new AgentError(
            'CHANGE_CAPTURE_BUSY',
            `File changed during command tracking: ${name}. Retry after other writers finish.`,
          );
        const fileHash =
          !buffer && cached?.signature === signature ? cached.hash : digest.digest('hex');
        hashes.set(name, { signature, hash: fileHash });
        let content: string | null = null;
        let binary = false;
        if (buffer) {
          try {
            content = new TextDecoder('utf8', { fatal: true }).decode(buffer);
            if (content.includes('\0')) {
              content = null;
              binary = true;
            }
          } catch {
            binary = true;
          }
        }
        files.set(name, {
          content,
          hash: fileHash,
          mode: info.mode,
          size: info.size,
          binary,
        });
      }
    };
    await walk(this.root);
    this.externalHashes = hashes;
    return files;
  }
  async recordExternal(before: Awaited<ReturnType<FileChangeService['snapshotExternal']>>) {
    const after = await this.snapshotExternal();
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const old = before.get(name),
        current = after.get(name);
      if (old?.hash === current?.hash && old?.mode === current?.mode) continue;
      const reviewable = old?.content !== null && current?.content !== null;
      const change: Change = {
        id: randomUUID(),
        path: name,
        oldPath: null,
        before: old?.content ?? null,
        beforeMode: old?.mode,
        afterMode: current?.mode,
        reviewable,
        binary: !!(old?.binary || current?.binary),
        exists: !!current,
        beforeSize: old?.size,
        afterSize: current?.size,
        after: current?.content ?? null,
        hash: current?.hash ?? null,
        accepted: false,
        undone: false,
      };
      this.history.push(change);
      this.events.emit('file.changed', {
        id: change.id,
        path: name,
        hash: change.hash,
        external: true,
        reviewable,
        binary: change.binary,
        exists: !!current,
      });
    }
  }
  private patchKey(diff: string, entries: FileEntry[]) {
    const declared = entries
      .map((entry) => [entry.path, entry.expectedHash] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
    return contentHash(JSON.stringify([diff, declared]));
  }
  private async parseOps(diff: string, entries: FileEntry[]): Promise<PlannedOp[]> {
    if (diff.trim() === '') throw new AgentError('PATCH_SCOPE', 'Patch contains no file sections');
    if (
      entries.length === 0 ||
      entries.length > 20 ||
      new Set(entries.map((entry) => entry.path)).size !== entries.length
    )
      throw new AgentError('PATCH_SCOPE', 'Declare 1 to 20 unique file entries');
    const patches = parsePatch(diff);
    if (patches.length === 0 || patches.length > 20)
      throw new AgentError('PATCH_SCOPE', 'Patch must contain 1 to 20 file sections');
    const declared = new Map(entries.map((entry) => [entry.path, entry]));
    const ops: PlannedOp[] = [];
    const touched = new Map<string, number>();
    const claim = (file: string) => {
      const previous = touched.get(file);
      if (previous !== undefined)
        throw new AgentError('PATCH_SCOPE', `Patch operations overlap on ${file}`);
      touched.set(file, ops.length);
    };
    for (const patch of patches) {
      const isNew = patch.oldFileName === '/dev/null';
      const isDelete = patch.newFileName === '/dev/null';
      const oldPath = normalizeHeader(patch.oldFileName);
      const newPath = normalizeHeader(patch.newFileName);
      const currentPath = isNew ? newPath : oldPath;
      const entry = declared.get(currentPath);
      if (!entry)
        throw new AgentError(
          'PATCH_PATH',
          `Patch touches ${currentPath} but no matching entry was declared for it`,
        );
      declared.delete(currentPath);
      if (isNew && (await this.read(await this.sandbox.resolve(this.root, newPath, true))) !== null)
        throw new AgentError('PATCH_PATH', `${newPath} already exists; read it before patching`);
      const before = isNew
        ? null
        : await this.read(await this.sandbox.resolve(this.root, currentPath, true));
      if ((before === null ? null : contentHash(before)) !== entry.expectedHash)
        throw new AgentError('STALE_FILE', `File changed; read ${currentPath} again`);
      if (!isNew && before === null)
        throw new AgentError('STALE_FILE', `File ${currentPath} no longer exists`);
      const beforeMode =
        before === null
          ? undefined
          : (await stat(await this.sandbox.resolve(this.root, currentPath, true))).mode;
      const base = before ?? '';
      const applied = applyPatch(base, patch, { fuzzFactor: 0 });
      if (applied === false)
        throw new AgentError('PATCH_CONFLICT', `Patch does not match content of ${currentPath}`);
      if (isNew) {
        if (entry.expectedHash !== null)
          throw new AgentError('STALE_FILE', `New file ${newPath} must declare expectedHash=null`);
        claim(newPath);
        ops.push({
          entry,
          oldPath: newPath,
          newPath,
          action: 'create',
          before: null,
          after: applied,
        });
      } else if (isDelete) {
        if (applied !== '')
          throw new AgentError(
            'PATCH_CONFLICT',
            `Deletion diff for ${oldPath} leaves content behind`,
          );
        claim(oldPath);
        ops.push({
          entry,
          oldPath,
          newPath: oldPath,
          action: 'delete',
          before,
          beforeMode,
          after: null,
        });
      } else if (oldPath !== newPath) {
        if ((await this.read(await this.sandbox.resolve(this.root, newPath, true))) !== null)
          throw new AgentError('PATCH_PATH', `${newPath} already exists; cannot rename onto it`);
        claim(oldPath);
        claim(newPath);
        ops.push({ entry, oldPath, newPath, action: 'rename', before, beforeMode, after: applied });
      } else {
        claim(oldPath);
        ops.push({ entry, oldPath, newPath, action: 'modify', before, beforeMode, after: applied });
      }
    }
    if (declared.size > 0)
      throw new AgentError(
        'PATCH_SCOPE',
        `Declared entry ${declared.keys().next().value ?? ''} has no matching patch section`,
      );
    return ops;
  }
  private summarize(op: PlannedOp): FileSummary {
    return {
      path: op.newPath,
      oldPath: op.action === 'rename' ? op.oldPath : null,
      action: op.action,
      after: op.after,
      hash: op.after === null ? null : contentHash(op.after),
      diff: createTwoFilesPatch(
        `a/${op.oldPath}`,
        `b/${op.newPath}`,
        op.before ?? '',
        op.after ?? '',
      ),
    };
  }
  private async safeCreate(target: string, after: string, mode?: number) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, after, { flag: 'wx', mode });
  }
  private async safeReplace(target: string, after: string, expectedBefore: string) {
    const temp = `${target}.hikari-${randomUUID()}`;
    try {
      await writeFile(temp, after, { flag: 'wx', mode: (await stat(target)).mode });
      const current = await this.read(target);
      if (current === null || contentHash(current) !== expectedBefore)
        throw new AgentError('STALE_FILE', 'File changed during patch preparation');
      await rename(temp, target);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  private async performOp(op: PlannedOp, journal: Array<() => Promise<void>>) {
    if (op.action === 'create' || op.action === 'rename') {
      const dest = await this.sandbox.resolve(this.root, op.newPath, true);
      if ((await this.read(dest)) !== null)
        throw new AgentError('PATCH_PATH', `${op.newPath} already exists`);
    }
    if (op.action === 'create') {
      const dest = await this.sandbox.resolve(this.root, op.newPath, true);
      await this.safeCreate(dest, op.after ?? '');
      journal.push(() => unlink(dest));
      return;
    }
    const source = await this.sandbox.resolve(this.root, op.oldPath, true);
    const current = await this.read(source);
    if (current === null || contentHash(current) !== op.entry.expectedHash)
      throw new AgentError('STALE_FILE', `File changed; read ${op.oldPath} again`);
    if (op.action === 'delete') {
      const source = await this.sandbox.resolve(this.root, op.oldPath, true);
      await unlink(source);
      journal.push(() => this.safeCreate(source, op.before ?? '', op.beforeMode));
      return;
    }
    if (op.action === 'rename') {
      const source = await this.sandbox.resolve(this.root, op.oldPath, true);
      const dest = await this.sandbox.resolve(this.root, op.newPath, true);
      await mkdir(path.dirname(dest), { recursive: true });
      await rename(source, dest);
      let movedContent = op.before ?? '';
      journal.push(async () => {
        const restored = await this.sandbox.resolve(this.root, op.oldPath, true);
        if ((await this.read(restored)) !== null)
          throw new AgentError('STALE_FILE', `Cannot roll back rename: ${op.oldPath} exists`);
        if ((await this.read(dest)) !== movedContent)
          throw new AgentError('STALE_FILE', `Cannot roll back rename: ${op.newPath} changed`);
        if (movedContent !== op.before)
          await this.safeReplace(dest, op.before ?? '', contentHash(movedContent));
        await rename(dest, restored);
      });
      if (op.after !== op.before && op.after !== null) {
        await this.safeReplace(dest, op.after, contentHash(op.before ?? ''));
        movedContent = op.after;
      }
      return;
    }
    const target = await this.sandbox.resolve(this.root, op.oldPath, true);
    const before = op.before ?? '';
    await this.safeReplace(target, op.after ?? '', contentHash(before));
    journal.push(() => this.safeReplace(target, before, contentHash(op.after ?? '')));
  }
  async previewFiles(entries: FileEntry[], diff: string): Promise<{ files: FileSummary[] }> {
    const ops = await this.parseOps(diff, entries);
    const key = this.patchKey(diff, entries);
    this.previews.add(key);
    if (this.previews.size > 100) this.previews.delete(this.previews.values().next().value!);
    return { files: ops.map((op) => this.summarize(op)) };
  }
  async applyFiles(
    entries: FileEntry[],
    diff: string,
  ): Promise<{ changes: Change[]; files: FileSummary[] }> {
    const ops = await this.parseOps(diff, entries);
    const key = this.patchKey(diff, entries);
    const hadPreview = this.previews.has(key);
    this.previews.delete(key);
    if (!hadPreview)
      throw new AgentError('PREVIEW_REQUIRED', 'Preview this exact patch before applying it');
    const journal: Array<() => Promise<void>> = [];
    try {
      for (const op of ops) await this.performOp(op, journal);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const rollback of journal.reverse())
        await rollback().catch((e) => rollbackErrors.push(e));
      if (rollbackErrors.length > 0)
        throw new AgentError(
          'ROLLBACK_FAILED',
          `Patch failed (${String(error)}) and rolling back ${rollbackErrors.length} of ${journal.length} operations failed; inspect the workspace`,
        );
      throw error;
    }
    const changes: Change[] = ops.map((op) => ({
      id: randomUUID(),
      path: op.newPath,
      oldPath: op.action === 'rename' ? op.oldPath : null,
      before: op.before,
      beforeMode: op.beforeMode,
      after: op.after,
      hash: op.after === null ? null : contentHash(op.after),
      accepted: false,
      undone: false,
    }));
    this.history.push(...changes);
    for (const [index, change] of changes.entries())
      this.events.emit('file.changed', {
        id: change.id,
        path: change.path,
        oldPath: change.oldPath,
        hash: change.hash,
        action: ops[index]!.action,
      });
    return { changes, files: ops.map((op) => this.summarize(op)) };
  }
  async write(file: string, after: string, expectedHash: string | null) {
    const target = await this.sandbox.resolve(this.root, file, true);
    const before = await this.read(target);
    if ((before === null ? null : contentHash(before)) !== expectedHash)
      throw new AgentError('STALE_FILE', 'File changed; read it again');
    await mkdir(path.dirname(target), { recursive: true });
    if (before === null) {
      await writeFile(target, after, { flag: 'wx' });
    } else {
      await this.safeReplace(target, after, contentHash(before));
    }
    const change: Change = {
      id: randomUUID(),
      path: file,
      oldPath: null,
      before,
      after,
      hash: contentHash(after),
      accepted: false,
      undone: false,
    };
    this.history.push(change);
    this.events.emit('file.changed', { id: change.id, path: file, hash: change.hash });
    return change;
  }
  async preview(file: string, diff: string, expectedHash: string) {
    if (parsePatch(diff).length !== 1)
      throw new AgentError('PATCH_SCOPE', 'One file per patch is required');
    const result = await this.previewFiles([{ path: file, expectedHash }], diff);
    const single = result.files[0]!;
    if (single.oldPath !== null || single.action === 'delete')
      throw new AgentError(
        'PATCH_PATH',
        'Patch headers must match the requested file; renames and deletions are not supported',
      );
    return { after: single.after!, diff: single.diff, hash: single.hash! };
  }
  async apply(file: string, diff: string, expectedHash: string) {
    const entries: FileEntry[] = [{ path: file, expectedHash }];
    const key = this.patchKey(diff, entries);
    const hadPreview = this.previews.has(key);
    await this.preview(file, diff, expectedHash);
    if (!hadPreview) {
      this.previews.delete(key);
      throw new AgentError('PREVIEW_REQUIRED', 'Preview this exact patch before applying it');
    }
    const result = await this.applyFiles(entries, diff);
    return result.changes[0]!;
  }
  accept(id: string) {
    const change = this.history.find((c) => c.id === id);
    if (!change) throw new AgentError('UNKNOWN_CHANGE', id);
    change.accepted = true;
  }
  async undo(id: string) {
    const change = this.history.find((c) => c.id === id);
    if (!change || change.undone) throw new AgentError('UNKNOWN_CHANGE', 'Change is unavailable');
    if (change.reviewable === false)
      throw new AgentError(
        'CHANGE_NOT_REVIEWABLE',
        'Binary or large changes require external review; no text backup is available for undo',
      );
    const target = await this.sandbox.resolve(this.root, change.path, true);
    if (change.hash === null) {
      if ((await this.read(target)) !== null)
        throw new AgentError('STALE_FILE', 'Cannot undo: file has subsequent changes');
      if (change.before !== null) await this.safeCreate(target, change.before, change.beforeMode);
    } else {
      const current = await this.read(target);
      if (current === null || contentHash(current) !== change.hash)
        throw new AgentError('STALE_FILE', 'Cannot undo: file has subsequent changes');
      if (change.before === null) {
        await unlink(target);
      } else if (change.oldPath !== null) {
        const restored = await this.sandbox.resolve(this.root, change.oldPath, true);
        if ((await this.read(restored)) !== null)
          throw new AgentError('STALE_FILE', `Cannot undo: ${change.oldPath} exists again`);
        await this.safeCreate(restored, change.before, change.beforeMode);
        try {
          await unlink(target);
        } catch (error) {
          // Undo did not finish: remove our new copy and keep the applied rename intact.
          if ((await this.read(restored)) === change.before) await unlink(restored);
          throw error;
        }
      } else {
        await this.safeReplace(target, change.before, change.hash);
      }
    }
    if (change.beforeMode !== undefined && change.before !== null)
      await chmod(
        change.oldPath ? await this.sandbox.resolve(this.root, change.oldPath, true) : target,
        change.beforeMode,
      );
    change.undone = true;
    this.events.emit('file.changed', { path: change.path, undo: id });
  }
}
