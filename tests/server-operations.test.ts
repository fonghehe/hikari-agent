import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SQLiteRepository } from '../packages/database/src';
import { AccountQuotas } from '../apps/server/src/quotas';
import { createServer } from '../apps/server/src/app';

it('uses persisted quota reservations across competing server instances and frees completed job capacity', async () => {
  const db = new SQLiteRepository(':memory:');
  try {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const outcomes = await Promise.allSettled(
      ids.map((id) => new AccountQuotas(db).reserve('jobs', 'owner', id, 2)),
    );
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(2);
    const accepted = ids.filter((_id, i) => outcomes[i]!.status === 'fulfilled');
    for (const id of accepted) await db.put('jobs', 'owner', id, { status: 'completed' }, 0);
    await expect(
      new AccountQuotas(db).reserve('jobs', 'owner', randomUUID(), 2),
    ).resolves.toBeUndefined();
    await expect(
      new AccountQuotas(db).reserve('jobs', 'other-owner', randomUUID(), 1),
    ).resolves.toBeUndefined();
  } finally {
    await db.close();
  }
});

it('exposes database readiness and protects diagnostic metrics behind a separate operator token', async () => {
  const db = new SQLiteRepository(':memory:');
  const token = 'operator-token-for-testing-only-00000';
  const app = await createServer(db, undefined, {}, { token });
  try {
    expect((await app.inject('/ready')).statusCode).toBe(200);
    expect((await app.inject('/operations/status')).statusCode).toBe(401);
    const metrics = await app.inject({
      url: '/operations/status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).not.toContain(token);
    expect(metrics.json()).toHaveProperty('memory');
  } finally {
    await app.close();
  }
});
