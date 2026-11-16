import { WorktreeService, worktreeFiles, bufferHash } from '@hikari/git';
import { LogicalSandboxProvider } from '@hikari/sandbox';
import { readFile } from 'node:fs/promises';
import { createTwoFilesPatch } from 'diff';
import { randomUUID } from 'node:crypto';
import { AgentError } from '@hikari/agent-core';
import { FileChangeService, type FileEntry } from './patch';
export interface DeliveryPreview {
  id: string;
  files: { path: string; conflict?: string; beforeHash: string | null; afterHash: string | null }[];
  diff: string;
  applicable: boolean;
}
export class WorktreeDelivery {
  private pending?: {
    preview: DeliveryPreview;
    taskId: string;
    entries: FileEntry[];
    target: string;
    after: Record<string, string | null>;
    modes: Record<string, { source?: number; target?: number }>;
  };
  constructor(readonly root: string) {}
  async preview(taskId: string) {
    const baseline = await new WorktreeService(this.root).baseline(taskId);
    const final = await worktreeFiles(baseline.target);
    const source = await worktreeFiles(this.root);
    const sandbox = new LogicalSandboxProvider();
    const files: DeliveryPreview['files'] = [],
      entries: FileEntry[] = [],
      after: Record<string, string | null> = Object.create(null);
    const modes: Record<string, { source?: number; target?: number }> = Object.create(null);
    const patches: string[] = [];
    for (const name of new Set([...Object.keys(baseline.base), ...Object.keys(final)])) {
      const old = baseline.base[name],
        current = final[name],
        original = baseline.source[name],
        target = source[name];
      if (old?.hash === current?.hash && old?.mode === current?.mode) continue;
      let conflict: string | undefined;
      if (original?.hash !== target?.hash || original?.mode !== target?.mode)
        conflict = 'Original workspace changed since this worktree was created';
      if (original?.hash !== old?.hash || original?.mode !== old?.mode)
        conflict = 'Pre-existing workspace edits differ from this worktree base';
      if (current && !old && (current.mode & 0o777) !== 0o644)
        conflict = 'New executable or special-mode files require external delivery';
      if (current && old && current.mode !== old.mode)
        conflict = 'File mode changes require external delivery';
      const oldBytes = target ? await readFile(await sandbox.resolve(this.root, name)) : null;
      const newBytes = current
        ? await readFile(await sandbox.resolve(baseline.target, name))
        : null;
      if (
        (oldBytes && bufferHash(oldBytes) !== target?.hash) ||
        (newBytes && bufferHash(newBytes) !== current?.hash)
      )
        throw new AgentError('STALE_FILE', `File changed during delivery preview: ${name}`);
      if ((oldBytes?.length ?? 0) > 512000 || (newBytes?.length ?? 0) > 512000)
        conflict = 'Large files require external delivery';
      let before = '',
        next = '';
      try {
        before = oldBytes ? new TextDecoder('utf8', { fatal: true }).decode(oldBytes) : '';
        next = newBytes ? new TextDecoder('utf8', { fatal: true }).decode(newBytes) : '';
        if (before.includes('\0') || next.includes('\0'))
          conflict = 'Binary files require external delivery';
      } catch {
        conflict = 'Binary files require external delivery';
      }
      files.push({
        path: name,
        conflict,
        beforeHash: target?.hash ?? null,
        afterHash: current?.hash ?? null,
      });
      if (!conflict) {
        entries.push({ path: name, expectedHash: target?.hash ?? null });
        patches.push(
          createTwoFilesPatch(
            target ? `a/${name}` : '/dev/null',
            current ? `b/${name}` : '/dev/null',
            before,
            next,
          ),
        );
        after[name] = current?.hash ?? null;
        modes[name] = { source: target?.mode, target: current?.mode };
      }
    }
    const preview: DeliveryPreview = {
      id: randomUUID(),
      files,
      diff: patches.join('\n'),
      applicable: files.length > 0 && files.length <= 20 && files.every((file) => !file.conflict),
    };
    this.pending = { preview, taskId, entries, target: baseline.target, after, modes };
    return preview;
  }
  async apply(previewId: string, changes: FileChangeService) {
    const pending = this.pending;
    if (!pending || pending.preview.id !== previewId || !pending.preview.applicable)
      throw new AgentError(
        'DELIVERY_PREVIEW',
        'Preview a conflict-free delivery of at most 20 text files first',
      );
    const final = await worktreeFiles(pending.target);
    const source = await worktreeFiles(this.root);
    for (const [name, expected] of Object.entries(pending.after))
      if (
        (final[name]?.hash ?? null) !== expected ||
        final[name]?.mode !== pending.modes[name]?.target ||
        source[name]?.mode !== pending.modes[name]?.source
      )
        throw new AgentError('STALE_FILE', `File changed after preview: ${name}`);
    await changes.previewFiles(pending.entries, pending.preview.diff);
    const result = await changes.applyFiles(pending.entries, pending.preview.diff);
    this.pending = undefined;
    return result;
  }
}
