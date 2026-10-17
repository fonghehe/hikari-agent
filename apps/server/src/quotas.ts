import { ConflictError, type Repository } from '@hikari/database';

/** Versioned reservations prevent concurrent API processes from oversubscribing an account. */
export class AccountQuotas {
  constructor(private repository: Repository) {}
  async reserve(
    kind: 'jobs' | 'workers',
    owner: string,
    id: string,
    maximum: number,
  ): Promise<void> {
    const key = `quota:${kind}`;
    for (let attempt = 0; attempt < 20; attempt++) {
      const guard = await this.repository.get('workspaces', owner, key);
      const pending = (guard?.data ?? {}) as Record<string, number>;
      const occupied = new Set<string>();
      for (let offset = 0; ; offset += 500) {
        const records = await this.repository.list(kind, owner, { offset, limit: 500 });
        for (const record of records) {
          const item = record.data as { status?: string };
          if (kind === 'workers' || ['queued', 'running'].includes(item.status ?? ''))
            occupied.add(record.id);
        }
        if (records.length < 500) break;
      }
      const next: Record<string, number> = {};
      for (const [reserved, expires] of Object.entries(pending)) {
        if (expires > Date.now() && !(await this.repository.get(kind, owner, reserved))) {
          occupied.add(reserved);
          next[reserved] = expires;
        }
      }
      if (occupied.has(id)) return;
      if (occupied.size >= maximum)
        throw Object.assign(new Error(`Account ${kind} quota reached`), { statusCode: 429 });
      next[id] = Date.now() + 60000;
      try {
        await this.repository.put('workspaces', owner, key, next, guard?.version ?? 0);
        return;
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
      }
    }
    throw Object.assign(new Error('Account quota is busy; retry later'), { statusCode: 429 });
  }
}
