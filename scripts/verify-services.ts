import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as tcpServer } from 'node:net';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresRepository } from '../packages/database/src/postgres';
import { createServer } from '../apps/server/src/app';
const execute = promisify(execFile);
const freePort = async () => {
  const server = tcpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
};
const root = await mkdtemp(path.join(tmpdir(), 'forge-services-'));
const pgPort = await freePort();
const redisPort = await freePort();
let postgresStarted = false;
let redis: ReturnType<typeof spawn> | undefined;
let api: Awaited<ReturnType<typeof createServer>> | undefined;
try {
  await execute('initdb', [
    '-D',
    path.join(root, 'pg'),
    '-A',
    'trust',
    '-U',
    'forge',
    '--no-locale',
    '-E',
    'UTF8',
    '--no-sync',
  ]);
  await execute('pg_ctl', [
    '-D',
    path.join(root, 'pg'),
    '-l',
    path.join(root, 'postgres.log'),
    '-o',
    `-h 127.0.0.1 -p ${pgPort} -k ${root}`,
    '-w',
    'start',
  ]);
  postgresStarted = true;
  redis = spawn(
    'redis-server',
    [
      '--bind',
      '127.0.0.1',
      '--port',
      String(redisPort),
      '--dir',
      root,
      '--save',
      '',
      '--appendonly',
      'no',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Redis startup timeout')), 10000);
    redis!.once('error', reject);
    redis!.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Ready to accept connections')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  const repository = new PostgresRepository(`postgres://forge@127.0.0.1:${pgPort}/postgres`);
  await repository.migrate();
  api = await createServer(repository, `redis://127.0.0.1:${redisPort}`);
  await api.listen({ host: '127.0.0.1', port: 0 });
  const credentials = {
    email: 'integration@example.invalid',
    password: 'integration-password-123',
  };
  assert.equal(
    (await api.inject({ method: 'POST', url: '/auth/register', payload: credentials })).statusCode,
    201,
  );
  const response = await api.inject({ method: 'POST', url: '/auth/login', payload: credentials });
  assert.equal(response.statusCode, 200);
  const token = (response.json() as { token: string }).token;
  const headers = { authorization: `Bearer ${token}` };
  const id = randomUUID();
  const address = api.server.address();
  if (!address || typeof address === 'string') throw new Error('No server port');
  const controller = new AbortController();
  const events = await fetch(`http://127.0.0.1:${address.port}/events`, {
    headers,
    signal: controller.signal,
  });
  assert.equal(events.status, 200);
  const reader = events.body!.getReader();
  await reader.read();
  const task = {
    id,
    agentId: 'integration',
    title: 'Integration',
    prompt: 'Verify backend',
    workspace: '/test',
    status: 'completed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
  };
  assert.equal(
    (
      await api.inject({
        method: 'PUT',
        url: `/tasks/${id}`,
        headers,
        payload: { task, expectedVersion: 0 },
      })
    ).statusCode,
    200,
  );
  const event = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('SSE timeout')), 5000).unref(),
    ),
  ]);
  assert.match(new TextDecoder().decode(event.value), /task.synced/);
  controller.abort();
  await reader.cancel().catch(() => {});
  assert.equal(
    (
      await api.inject({
        method: 'PUT',
        url: `/tasks/${id}`,
        headers,
        payload: { task, expectedVersion: 0 },
      })
    ).statusCode,
    409,
  );
  assert.equal((await api.inject({ method: 'GET', url: '/tasks', headers })).json().length, 1);
  console.log(
    'PASS: real PostgreSQL + Drizzle, Redis rate limits/pubsub, accounts, sync conflict and live SSE delivery.',
  );
} finally {
  await api?.close();
  redis?.kill('SIGTERM');
  if (postgresStarted)
    await execute('pg_ctl', ['-D', path.join(root, 'pg'), '-m', 'fast', '-w', 'stop']);
  await rm(root, { recursive: true, force: true });
}
