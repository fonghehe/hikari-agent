import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  openSync,
  closeSync,
} from 'node:fs';

/** Local control-plane state. Never model-visible and never synchronized as conversation data. */
export class StateStore {
  readonly directory: string;
  constructor(readonly root: string) {
    this.directory = path.join(root, '.agent', 'state');
    for (const folder of [path.join(root, '.agent'), this.directory]) {
      if (
        existsSync(folder) &&
        (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory())
      )
        throw new Error('Platform storage must use real directories');
      mkdirSync(folder, { recursive: true, mode: 0o700 });
    }
  }
  private filename(key: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key)) throw new Error('Invalid state key');
    return path.join(this.directory, `${key}.json`);
  }
  get<T>(key: string): T | undefined {
    const filename = this.filename(key);
    if (!existsSync(filename)) return;
    const info = lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16000000)
      throw new Error('Invalid platform state file');
    return JSON.parse(readFileSync(filename, 'utf8')) as T;
  }
  set(key: string, value: unknown) {
    const filename = this.filename(key);
    // Validate an existing target before replacing it.
    this.get(key);
    const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
    const content = JSON.stringify(value);
    if (Buffer.byteLength(content) > 16000000) throw new Error('Platform state exceeds 16 MB');
    try {
      writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, filename);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  delete(key: string) {
    const filename = this.filename(key);
    if (this.get(key) !== undefined) unlinkSync(filename);
  }
  lease(key: string): () => void {
    const filename = this.filename(key) + '.owner';
    const nonce = randomUUID();
    let fd: number;
    try {
      fd = openSync(filename, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (lstatSync(filename).isSymbolicLink()) throw new Error('Invalid scheduler owner file');
      const owner = JSON.parse(readFileSync(filename, 'utf8')) as { pid: number; nonce: string };
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
        throw new Error('Invalid scheduler owner');
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          unlinkSync(filename);
          return this.lease(key);
        }
        throw error;
      }
      throw new Error('Another Hikari scheduler owns this project');
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
    } finally {
      closeSync(fd);
    }
    return () => {
      if (!existsSync(filename)) return;
      const owner = JSON.parse(readFileSync(filename, 'utf8')) as { nonce: string };
      if (owner.nonce === nonce) unlinkSync(filename);
    };
  }
  /** A synchronous, cross-process transaction. A crashed lock requires explicit operator removal. */
  transaction<T>(key: string, update: () => T): T {
    const filename = this.filename(key) + '.lock';
    let fd: number;
    try {
      fd = openSync(filename, 'wx', 0o600);
    } catch {
      throw new Error(`Platform state is locked: ${key}`);
    }
    try {
      return update();
    } finally {
      closeSync(fd);
      unlinkSync(filename);
    }
  }
  async transactionAsync<T>(key: string, update: () => Promise<T>): Promise<T> {
    const filename = this.filename(key) + '.lock';
    let fd: number;
    try {
      fd = openSync(filename, 'wx', 0o600);
    } catch {
      throw new Error(`Platform state is locked: ${key}`);
    }
    try {
      return await update();
    } finally {
      closeSync(fd);
      unlinkSync(filename);
    }
  }
}
