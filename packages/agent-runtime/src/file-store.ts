import path from 'node:path';
import {
  mkdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { states, type Task } from '@hikari/agent-core';
import { parseCheckpoint, type RunnerCheckpoint, type CheckpointStore } from './checkpoint';
import type { MemoryEntry, MemoryStore } from './memory';
export class FileRunStore implements CheckpointStore, MemoryStore {
  private directory: string;
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
    const filename = this.filename(id);
    const old = this.read(filename) as { task?: Task } | undefined;
    this.write(filename, { task: old?.task, checkpoint });
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
