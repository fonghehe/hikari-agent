import { StateStore } from './state-store';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

interface Owner {
  pid: number;
  taskId: string;
  nonce: string;
  startedAt: string;
}
const key = 'execution-owner';

/** A workspace execution claim shared by desktop, CLI and worker processes. */
export class WorkspaceOwnership {
  private store: StateStore;
  constructor(root: string) {
    this.store = new StateStore(realpathSync(root));
  }
  static current(root: string) {
    if (!existsSync(path.join(root, '.agent', 'state', `${key}.json`))) return;
    return new WorkspaceOwnership(root).active();
  }
  active(): Owner | undefined {
    const owner = this.store.get<Owner>(key);
    if (!owner) return;
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !owner.nonce || !owner.taskId)
      throw new Error('Invalid workspace execution owner; inspect private platform state');
    try {
      process.kill(owner.pid, 0);
      return owner;
    } catch (error) {
      // Permission errors mean the process may still be alive. Never steal its claim.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return owner;
    }
  }
  acquire(taskId: string): () => void {
    const nonce = randomUUID();
    this.store.transaction(key, () => {
      const owner = this.active();
      if (owner) throw new Error(`Workspace busy: task ${owner.taskId} in process ${owner.pid}`);
      this.store.set(key, { pid: process.pid, taskId, nonce, startedAt: new Date().toISOString() });
    });
    let released = false;
    return () => {
      if (released) return;
      this.store.transaction(key, () => {
        if (this.store.get<Owner>(key)?.nonce === nonce) this.store.delete(key);
      });
      released = true;
    };
  }
}
