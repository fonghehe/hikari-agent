import { it, expect } from 'vitest';
import { SQLiteRepository, ConflictError } from '../packages/database/src';
import { createServer } from '../apps/server/src/app';
import { randomUUID } from 'node:crypto';
it('persists owner-scoped records and rejects stale updates', async () => {
  const repository = new SQLiteRepository(':memory:');
  try {
    await repository.put('tasks', 'alice', 'task', { title: 'first' }, 0);
    expect(await repository.get('tasks', 'bob', 'task')).toBeUndefined();
    await expect(
      repository.put('tasks', 'alice', 'task', { title: 'lost update' }, 0),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await repository.get('tasks', 'alice', 'task'))?.version).toBe(1);
  } finally {
    await repository.close();
  }
});
it('supports accounts, authorization and optimistic task synchronization', async () => {
  const app = await createServer(new SQLiteRepository(':memory:'));
  try {
    expect((await app.inject({ method: 'GET', url: '/tasks' })).statusCode).toBe(401);
    const credentials = { email: 'test@example.invalid', password: 'test-password-123' };
    expect(
      (await app.inject({ method: 'POST', url: '/auth/register', payload: credentials }))
        .statusCode,
    ).toBe(201);
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: credentials });
    expect(login.statusCode).toBe(200);
    const token = (login.json() as { token: string }).token;
    const id = randomUUID();
    const task = {
      id,
      agentId: 'agent',
      title: 'A task',
      prompt: 'Inspect files',
      demo: true,
      workspace: '/fixture',
      runOptions: { mode: 'plan', maxSteps: 8 },
      plan: { steps: [{ id: 'inspect', text: 'Inspect files', status: 'completed' }] },
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
    };
    const headers = { authorization: `Bearer ${token}` };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/tasks/${id}`,
          headers,
          payload: { task, expectedVersion: 0 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/tasks/${id}`,
          headers,
          payload: { task, expectedVersion: 0 },
        })
      ).statusCode,
    ).toBe(409);
    const snapshots = (await app.inject({ method: 'GET', url: '/tasks', headers })).json();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].data.plan).toEqual(task.plan);
    expect(snapshots[0].data.runOptions).toEqual(task.runOptions);
    expect(snapshots[0].data.demo).toBe(true);
    await app.inject({ method: 'POST', url: '/auth/logout', headers });
    expect((await app.inject({ method: 'GET', url: '/tasks', headers })).statusCode).toBe(401);
  } finally {
    await app.close();
  }
});

it('delivers authorized WebSocket notifications without leaking other users tasks', async () => {
  const app = await createServer(new SQLiteRepository(':memory:'));
  let socket: Awaited<ReturnType<typeof app.injectWS>> | undefined;
  try {
    const credentials = { email: 'socket@example.invalid', password: 'socket-password-123' };
    await app.inject({ method: 'POST', url: '/auth/register', payload: credentials });
    const token = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: credentials })
    ).json().token as string;
    const messages: string[] = [];
    socket = await app.injectWS(
      '/ws',
      { headers: { authorization: `Bearer ${token}` } },
      {
        onInit: (client) => {
          client.on('message', (data: unknown) => messages.push(String(data)));
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const id = randomUUID();
    const task = {
      id,
      agentId: 'agent',
      title: 'Notify',
      prompt: 'Test',
      workspace: '/fixture',
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
    };
    await app.inject({
      method: 'PUT',
      url: `/tasks/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { task, expectedVersion: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(messages.some((message) => message.includes('task.synced'))).toBe(true);
    await expect(
      app.injectWS('/ws', { headers: { authorization: 'Bearer invalid' } }),
    ).rejects.toThrow();
  } finally {
    socket?.terminate();
    await app.close();
  }
});
it('paginates task history deterministically beyond 500 records and restores all local tasks', async () => {
  const { LocalPersistence } = await import('../apps/desktop/src/main/persistence');
  const store = new LocalPersistence(':memory:');
  try {
    for (let index = 0; index < 530; index++)
      store.save('tasks', `task-${String(index).padStart(4, '0')}`, { id: String(index) });
    const page = store.repository.listSync('tasks', 'local', { limit: 500 });
    const remaining = store.repository.listSync('tasks', 'local', { limit: 500, offset: 500 });
    expect(page).toHaveLength(500);
    expect(remaining).toHaveLength(30);
    expect(new Set([...page, ...remaining].map((item) => item.id)).size).toBe(530);
    expect(store.tasks()).toHaveLength(530);
    expect(() => store.repository.listSync('tasks', 'local', { limit: -1 })).toThrow('pagination');
  } finally {
    await store.close();
  }
});
it('shares vector batches across concurrent task handles and restores persisted cache entries', async () => {
  const { LocalPersistence } = await import('../apps/desktop/src/main/persistence');
  const store = new LocalPersistence(':memory:');
  try {
    const first = store.vectors('project'),
      second = store.vectors('project');
    first.putMany([
      ['one', [1, 0]],
      ['two', [0, 1]],
    ]);
    second.put('three', [1, 1]);
    expect(first.get('three')).toEqual([1, 1]);
    expect(second.get('one')).toEqual([1, 0]);
    expect(store.get('messages', 'vectors:project')?.data).toEqual({
      one: [1, 0],
      two: [0, 1],
      three: [1, 1],
    });
    expect(store.vectors('other').get('one')).toBeUndefined();
  } finally {
    await store.close();
  }
});
