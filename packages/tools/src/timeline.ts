import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { AgentError, type Task } from '@hikari/agent-core';
import { StateStore, WorkspaceOwnership, type RunnerCheckpoint } from '@hikari/agent-runtime';
import { FileChangeService, type FileEntry } from './patch';

interface TimelineFile {
  hash: string;
  mode: number;
  content: string | null;
}
export interface TimelineEntry {
  id: string;
  taskId: string;
  label: string;
  at: string;
  task: Task;
  checkpoint?: RunnerCheckpoint;
  files: Record<string, TimelineFile>;
}
export class TimelineService {
  private store: StateStore;
  constructor(readonly root: string) {
    this.store = new StateStore(root);
  }
  list(taskId?: string) {
    return (
      this.store.get<{ id: string; taskId: string; label: string; at: string }[]>('timeline') ?? []
    ).filter((item) => !taskId || item.taskId === taskId);
  }
  read(id: string) {
    const item = this.store.get<TimelineEntry>(`timeline-${id}`);
    if (!item || item.id !== id) throw new Error('Unknown timeline checkpoint');
    return item;
  }
  async capture(task: Task, checkpoint: RunnerCheckpoint | undefined, label: string) {
    const snapshot = await new FileChangeService(this.root, { emit() {} }).snapshotExternal();
    let bytes = 0;
    const files = Object.fromEntries(
      [...snapshot].map(([name, item]) => {
        bytes += Buffer.byteLength(item.content ?? '');
        return [
          name,
          { hash: item.hash, mode: item.mode, content: bytes <= 8000000 ? item.content : null },
        ];
      }),
    );
    const item: TimelineEntry = {
      id: randomUUID(),
      taskId: task.id,
      label,
      at: new Date().toISOString(),
      task: { ...structuredClone(task), events: [] },
      checkpoint,
      files,
    };
    this.store.set(`timeline-${item.id}`, item);
    this.store.transaction('timeline', () => {
      const entries = [...this.list(), { id: item.id, taskId: task.id, label, at: item.at }];
      this.store.set('timeline', entries.slice(-100));
      for (const expired of entries.slice(0, -100)) this.store.delete(`timeline-${expired.id}`);
    });
    return item.id;
  }
  async preview(id: string) {
    const target = this.read(id);
    const latest = this.read(this.list().at(-1)?.id ?? id);
    const current = await new FileChangeService(this.root, { emit() {} }).snapshotExternal();
    const files: { path: string; conflict?: string }[] = [];
    const entries: FileEntry[] = [];
    const diffs = [];
    for (const name of new Set([...Object.keys(target.files), ...Object.keys(latest.files)])) {
      const desired = target.files[name],
        expected = latest.files[name],
        actual = current.get(name);
      if (desired?.hash === expected?.hash && desired?.mode === expected?.mode) continue;
      let conflict: string | undefined;
      if (actual?.hash !== expected?.hash || actual?.mode !== expected?.mode)
        conflict = 'File changed after the latest recorded state';
      if ((desired && desired.content === null) || (actual && actual.content === null))
        conflict = 'Binary or large file requires external restoration';
      if (
        (desired && actual && desired.mode !== actual.mode) ||
        (desired && !actual && (desired.mode & 0o777) !== 0o644)
      )
        conflict = 'File permissions require external restoration';
      files.push({ path: name, conflict });
      if (!conflict) {
        entries.push({ path: name, expectedHash: actual?.hash ?? null });
        diffs.push(
          createTwoFilesPatch(
            actual ? `a/${name}` : '/dev/null',
            desired ? `b/${name}` : '/dev/null',
            actual?.content ?? '',
            desired?.content ?? '',
          ),
        );
      }
    }
    return {
      files,
      diff: diffs.join('\n'),
      entries,
      applicable: files.every((item) => !item.conflict) && files.length <= 20,
    };
  }
  async restore(id: string, mode: 'code' | 'conversation' | 'both', changes: FileChangeService) {
    const release = new WorkspaceOwnership(this.root).acquire(`restore-${id}`);
    try {
      const target = this.read(id);
      if (mode !== 'code' && !target.checkpoint)
        throw new Error('This checkpoint has no conversation state');
      if (mode !== 'conversation') {
        const preview = await this.preview(id);
        if (!preview.applicable)
          throw new AgentError(
            'TIMELINE_CONFLICT',
            'Resolve timeline conflicts before restoring; at most 20 text files can be restored together',
          );
        if (preview.entries.length) {
          await changes.previewFiles(preview.entries, preview.diff);
          await changes.applyFiles(preview.entries, preview.diff);
        }
        const latest = this.read(this.list(target.taskId).at(-1)?.id ?? id);
        await this.capture(
          mode === 'code' ? latest.task : target.task,
          mode === 'code' ? latest.checkpoint : target.checkpoint,
          'restored',
        );
      }
      if (mode === 'code') return;
      const checkpoint = structuredClone(target.checkpoint!);
      checkpoint.pending = [];
      checkpoint.queued = [];
      checkpoint.answeredQuestion = undefined;
      checkpoint.done = false;
      checkpoint.testedRevision = {};
      checkpoint.revision++;
      checkpoint.needsVerification = true;
      checkpoint.summary.verification = undefined;
      checkpoint.summary.stopReason = undefined;
      if (checkpoint.goal)
        checkpoint.goal = {
          ...checkpoint.goal,
          status: 'active',
          continuations: 0,
          evidence: undefined,
        };
      // A rewind starts a new run; previous usage is evidence, never an authorization or a new budget charge.
      checkpoint.summary = {
        modelSteps: 0,
        toolCalls: 0,
        toolFailures: 0,
        durationMs: 0,
        filesChanged: [],
        tests: [],
      };
      checkpoint.messages.push({
        role: 'user',
        content:
          'Conversation restored into a new task. Inspect the current files; earlier tests and authorizations are invalid for this run.',
      });
      checkpoint.updatedAt = new Date().toISOString();
      return { task: target.task, checkpoint };
    } finally {
      release();
    }
  }
}
