import path from 'node:path';
import {
  mkdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { states, type Task, type AgentEvent } from '@hikari/agent-core';
import { TaskWriteBuffer } from './persistence-buffer';
import { appendRequestTrace, parseRequestTraces, type ModelRequestTrace } from './request-trace';
import { parseCheckpoint, type RunnerCheckpoint, type CheckpointStore } from './checkpoint';
import type { MemoryEntry, MemoryStore } from './memory';
export class FileRunStore implements CheckpointStore, MemoryStore {
  private directory: string;
  private writes = new TaskWriteBuffer((entries) => {
    for (const { task } of entries) this.saveTask(task);
  });
  recordTask(task: Task, event?: AgentEvent) {
    this.writes.update(task, event);
  }
  flush(id?: string) {
    this.writes.flush(id);
  }
  close() {
    this.flush();
  }
  private requestsFile(id: string) {
    return path.join(this.directory, `requests-${z.string().uuid().parse(id)}.json`);
  }
  requests(id: string) {
    return parseRequestTraces(this.read(this.requestsFile(id)));
  }
  saveRequest(id: string, trace: ModelRequestTrace) {
    this.write(this.requestsFile(id), appendRequestTrace(this.requests(id), trace));
  }
  constructor(readonly root: string) {
    this.directory = path.join(root, '.agent', 'runs');
    for (const folder of [path.join(root, '.agent'), this.directory]) {
      if (existsSync(folder) && lstatSync(folder).isSymbolicLink())
        throw new Error('Run storage cannot use symbolic links');
      mkdirSync(folder, { recursive: true, mode: 0o700 });
    }
  }
  private filename(id: string) {
    return path.join(this.directory, z.string().uuid().parse(id) + '.json');
  }
  private read(filename: string): unknown {
    if (!existsSync(filename)) return undefined;
    const info = lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 50000000)
      throw new Error('Invalid run storage file');
    return JSON.parse(readFileSync(filename, 'utf8'));
  }
  private write(filename: string, value: unknown) {
    const temporary = path.join(this.directory, randomUUID() + '.tmp');
    try {
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      renameSync(temporary, filename);
    } finally {
      if (existsSync(temporary)) {
        unlinkSync(temporary);
      }
    }
  }
  task(id: string): Task | undefined {
    this.flush(id);
    const record = this.read(this.filename(id)) as { task?: Task } | undefined;
    const task = record?.task;
    if (!task) return;
    if (
      task.id !== id ||
      task.workspace !== this.root ||
      !states.includes(task.status) ||
      !Array.isArray(task.events)
    )
      throw new Error('Run metadata does not match this workspace');
    return task;
  }
  tasks(): Task[] {
    return readdirSync(this.directory)
      .filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name))
      .map((name) => this.task(name.slice(0, -5)))
      .filter((task): task is Task => !!task);
  }
  saveTask(task: Task) {
    const filename = this.filename(task.id);
    const old = this.read(filename) as { checkpoint?: RunnerCheckpoint } | undefined;
    this.write(filename, { task, checkpoint: old?.checkpoint });
  }
  load(id: string) {
    const record = this.read(this.filename(id)) as { checkpoint?: unknown } | undefined;
    return parseCheckpoint(record?.checkpoint);
  }
  save(id: string, checkpoint: RunnerCheckpoint) {
    this.flush(id);
    const filename = this.filename(id);
    const old = this.read(filename) as { task?: Task } | undefined;
    this.write(filename, { task: old?.task, checkpoint });
  }
  private outputFile(taskId: string, id: string) {
    return path.join(
      this.directory,
      `output-${z.string().uuid().parse(taskId)}-${z.string().uuid().parse(id)}.json`,
    );
  }
  saveOutput(taskId: string, id: string, content: string) {
    this.write(this.outputFile(taskId, id), content);
  }
  loadOutput(taskId: string, id: string) {
    const value = this.read(this.outputFile(taskId, id));
    if (value !== undefined && typeof value !== 'string')
      throw new Error('Invalid saved tool result');
    return value as string | undefined;
  }
  private memoryFile(scope: string) {
    return path.join(
      this.directory,
      `memory-${createHash('sha256').update(scope).digest('hex')}.json`,
    );
  }
  list(scope: string): MemoryEntry[] {
    return z
      .array(
        z.object({
          id: z.string().uuid(),
          title: z.string().max(150),
          content: z.string().max(4000),
          updatedAt: z.string(),
          source: z.string().max(500).optional(),
          expiresAt: z.string().datetime().optional(),
        }),
      )
      .max(100)
      .parse(this.read(this.memoryFile(scope)) ?? []);
  }
  put(scope: string, entry: MemoryEntry) {
    this.write(this.memoryFile(scope), [
      ...this.list(scope).filter((item) => item.id !== entry.id),
      entry,
    ]);
  }
  remove(scope: string, id: string) {
    this.write(
      this.memoryFile(scope),
      this.list(scope).filter((item) => item.id !== id),
    );
  }
}
