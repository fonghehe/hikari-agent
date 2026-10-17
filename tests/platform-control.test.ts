import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { randomUUID, createHmac } from 'node:crypto';
import { RemoteControlServer, remoteHTML, type ControlAdapter } from '../packages/agent-host/src';
import { TaskManager } from '../packages/agent-runtime/src';
import { SQLiteRepository } from '../packages/database/src';
import { createServer } from '../apps/server/src/app';
import { executionConsole } from '../apps/server/src/console';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
it('serves valid browser scripts with no embedded access token', () => {
  for (const html of [remoteHTML, executionConsole]) {
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Script(script!)).not.toThrow();
    expect(html).not.toContain('innerHTML');
  }
});
it('authenticates remote control, rejects foreign origins, and scopes task operations to the project', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-remote-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const tasks = new TaskManager();
  const task = tasks.create('fixture', root);
  const foreign = tasks.create('private', '/other/project');
  const adapter: ControlAdapter = {
    root,
    list: () => tasks.list(),
    start: vi.fn(async (prompt) => tasks.create(prompt, root)),
    control: vi.fn(async () => {}),
    input: vi.fn(),
    approve: vi.fn(),
    answer: vi.fn(),
  };
  const server = new RemoteControlServer(adapter, 'a'.repeat(64));
  const info = await server.listen(0);
  cleanup.push(() => server.close());
  const base = `http://127.0.0.1:${info.port}`;
  expect((await fetch(base + '/api/tasks')).status).toBe(401);
  expect((await fetch(base + '/api/tasks?token=' + info.token)).status).toBe(401);
  const headers = { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' };
  expect(
    (
      await fetch(base + '/api/tasks', {
        headers: { ...headers, Origin: 'https://untrusted.example' },
      })
    ).status,
  ).toBe(403);
  const list = (await (await fetch(base + '/api/tasks', { headers })).json()) as {
    tasks: { id: string }[];
  };
  expect(list.tasks.map((item) => item.id)).toEqual([task.id]);
  expect(
    (
      await fetch(base + `/api/tasks/${foreign.id}/input`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'read private data' }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(base + `/api/tasks/${task.id}/input`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'new evidence' }),
      })
    ).status,
  ).toBe(200);
  expect(adapter.input).toHaveBeenCalledWith(task.id, 'new evidence');
  const page = await fetch(base);
  expect(page.headers.get('content-security-policy')).toContain('frame-ancestors');
  expect(await page.text()).not.toContain(info.token);
});

async function cloud(withGitHub = false) {
  const repository = new SQLiteRepository(':memory:');
  const route = {
    repository: 'owner/project',
    owner: randomUUID(),
    workerId: randomUUID(),
    project: 'project',
    allowedActors: ['maintainer'],
    postResults: false,
  };
  const app = await createServer(
    repository,
    undefined,
    withGitHub ? { webhookSecret: 'fixture-secret', github: [route] } : {},
  );
  cleanup.push(() => app.close());
  async function account(email: string) {
    const registered = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'fixture-password-123' },
    });
    expect(registered.statusCode).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'fixture-password-123' },
    });
    return { id: registered.json().id as string, authorization: 'Bearer ' + login.json().token };
  }
  const user = await account('owner@example.test');
  const workerResponse = await app.inject({
    method: 'POST',
    url: '/execution/workers',
    headers: { authorization: user.authorization },
    payload: { name: 'fixture', projects: ['project'] },
  });
  expect(workerResponse.statusCode).toBe(201);
  const worker = workerResponse.json() as { id: string; workerToken: string };
  Object.assign(route, { owner: user.id, workerId: worker.id });
  const enqueue = () =>
    app.inject({
      method: 'POST',
      url: '/execution/jobs',
      headers: { authorization: user.authorization },
      payload: {
        workerId: worker.id,
        project: 'project',
        prompt: 'Inspect fixture',
        options: { mode: 'plan' },
        isolated: false,
      },
    });
  return { app, repository, user, worker, account, enqueue };
}
it('claims a cloud job once and enforces owner, worker and execution-lease boundaries', async () => {
  const c = await cloud();
  const job = (await c.enqueue()).json();
  const claims = await Promise.all([
    c.app.inject({
      method: 'POST',
      url: '/worker/claim',
      headers: { authorization: 'Bearer ' + c.worker.workerToken },
      payload: {},
    }),
    c.app.inject({
      method: 'POST',
      url: '/worker/claim',
      headers: { authorization: 'Bearer ' + c.worker.workerToken },
      payload: {},
    }),
  ]);
  const claimed = claims.map((response) => response.json()).filter((value) => value?.id === job.id);
  expect(claimed).toHaveLength(1);
  const outsider = await c.account('outsider@example.test');
  expect(
    (
      await c.app.inject({
        method: 'GET',
        url: `/execution/jobs/${job.id}`,
        headers: { authorization: outsider.authorization },
      })
    ).statusCode,
  ).toBe(404);
  const visible = await c.app.inject({
    method: 'GET',
    url: `/execution/jobs/${job.id}`,
    headers: { authorization: c.user.authorization },
  });
  expect(visible.json()).not.toHaveProperty('lease');
  expect(
    (
      await c.app.inject({
        method: 'POST',
        url: `/worker/jobs/${job.id}`,
        headers: { authorization: 'Bearer ' + c.worker.workerToken },
        payload: { lease: 'forged', status: 'completed' },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await c.app.inject({
        method: 'POST',
        url: `/worker/jobs/${job.id}`,
        headers: { authorization: 'Bearer ' + c.worker.workerToken },
        payload: { lease: claimed[0].lease, status: 'completed' },
      })
    ).statusCode,
  ).toBe(200);
});
it('persists remote commands until acknowledged and never requeues expired executions', async () => {
  const c = await cloud();
  const job = (await c.enqueue()).json();
  const claim = (
    await c.app.inject({
      method: 'POST',
      url: '/worker/claim',
      headers: { authorization: 'Bearer ' + c.worker.workerToken },
      payload: {},
    })
  ).json();
  await c.app.inject({
    method: 'POST',
    url: `/execution/jobs/${job.id}/commands`,
    headers: { authorization: c.user.authorization },
    payload: { action: 'input', text: 'New requirement' },
  });
  const update = (payload: Record<string, unknown>) =>
    c.app.inject({
      method: 'POST',
      url: `/worker/jobs/${job.id}`,
      headers: { authorization: 'Bearer ' + c.worker.workerToken },
      payload,
    });
  const response = await update({ lease: claim.lease, status: 'running' });
  const command = response.json().commands[0];
  expect(command.text).toBe('New requirement');
  expect(
    (await update({ lease: claim.lease, status: 'running', ack: [command.id] })).json().commands,
  ).toEqual([]);
  const record = await c.repository.get('jobs', c.user.id, job.id);
  await c.repository.put(
    'jobs',
    c.user.id,
    job.id,
    { ...(record!.data as object), leaseExpires: 0 },
    record!.version,
  );
  expect(
    (
      await c.app.inject({
        method: 'POST',
        url: '/worker/claim',
        headers: { authorization: 'Bearer ' + c.worker.workerToken },
        payload: {},
      })
    ).json(),
  ).toBeNull();
  expect(
    (
      await c.app.inject({
        method: 'GET',
        url: `/execution/jobs/${job.id}`,
        headers: { authorization: c.user.authorization },
      })
    ).json().status,
  ).toBe('interrupted');
});
it('allows normal worker heartbeats and console polling without exhausting command limits', async () => {
  const c = await cloud();
  const job = (await c.enqueue()).json();
  const claimed = (
    await c.app.inject({
      method: 'POST',
      url: '/worker/claim',
      headers: { authorization: 'Bearer ' + c.worker.workerToken },
      payload: {},
    })
  ).json();
  for (let tick = 0; tick < 65; tick++) {
    expect(
      (
        await c.app.inject({
          method: 'POST',
          url: `/worker/jobs/${job.id}`,
          headers: { authorization: 'Bearer ' + c.worker.workerToken },
          payload: { lease: claimed.lease, status: 'running' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await c.app.inject({
          method: 'GET',
          url: '/execution/jobs',
          headers: { authorization: c.user.authorization },
        })
      ).statusCode,
    ).toBe(200);
  }
  expect(
    (
      await c.app.inject({
        method: 'POST',
        url: `/execution/jobs/${job.id}/commands`,
        headers: { authorization: c.user.authorization },
        payload: { action: 'input', text: 'Continue with the new evidence' },
      })
    ).statusCode,
  ).toBe(200);
});
it('validates webhook signatures, actor allowlists and delivery idempotency before creating review jobs', async () => {
  const c = await cloud(true);
  const body = JSON.stringify({
    action: 'opened',
    repository: { full_name: 'owner/project' },
    sender: { login: 'maintainer' },
    pull_request: { number: 1, title: 'Review fixture', body: 'Reference only' },
  });
  const headers = {
    'content-type': 'application/json',
    'x-github-event': 'pull_request',
    'x-github-delivery': randomUUID(),
    'x-hub-signature-256':
      'sha256=' + createHmac('sha256', 'fixture-secret').update(body).digest('hex'),
  };
  expect(
    (
      await c.app.inject({
        method: 'POST',
        url: '/integrations/github/webhook',
        headers: { ...headers, 'x-hub-signature-256': 'sha256=invalid' },
        payload: body,
      })
    ).statusCode,
  ).toBe(401);
  const accepted = await c.app.inject({
    method: 'POST',
    url: '/integrations/github/webhook',
    headers,
    payload: body,
  });
  expect(accepted.statusCode).toBe(202);
  expect(
    (
      await c.app.inject({
        method: 'POST',
        url: '/integrations/github/webhook',
        headers,
        payload: body,
      })
    ).json(),
  ).toMatchObject({ duplicate: true });
  const jobs = (
    await c.app.inject({
      method: 'GET',
      url: '/execution/jobs',
      headers: { authorization: c.user.authorization },
    })
  ).json();
  expect(jobs).toHaveLength(1);
  expect(jobs[0].options.mode).toBe('plan');
  const foreign = body.replace('maintainer', 'outsider');
  expect(
    (
      await c.app.inject({
        method: 'POST',
        url: '/integrations/github/webhook',
        headers: {
          ...headers,
          'x-github-delivery': randomUUID(),
          'x-hub-signature-256':
            'sha256=' + createHmac('sha256', 'fixture-secret').update(foreign).digest('hex'),
        },
        payload: foreign,
      })
    ).statusCode,
  ).toBe(403);
});

it('makes concurrent claim retries and final-state retries idempotent', async () => {
  const c = await cloud();
  await c.enqueue();
  await c.enqueue();
  const headers = { authorization: 'Bearer ' + c.worker.workerToken };
  const claimId = randomUUID();
  const claim = () =>
    c.app.inject({ method: 'POST', url: '/worker/claim', headers, payload: { claimId } });
  const initial = await Promise.all([claim(), claim()]);
  const successful = initial
    .filter((result) => result.statusCode === 200)
    .map((result) => result.json());
  const job = (await claim()).json();
  expect(successful.length).toBeGreaterThan(0);
  expect(successful.every((value) => value.id === job.id && value.lease === job.lease)).toBe(true);
  const records = await c.repository.list('jobs', c.user.id);
  expect(
    records.filter((record) => (record.data as { status: string }).status === 'running'),
  ).toHaveLength(1);
  const updateId = randomUUID();
  const complete = (lease = job.lease, id = updateId) =>
    c.app.inject({
      method: 'POST',
      url: `/worker/jobs/${job.id}`,
      headers,
      payload: { lease, updateId: id, status: 'completed' },
    });
  expect((await complete()).statusCode).toBe(200);
  const version = (await c.repository.get('jobs', c.user.id, job.id))!.version;
  expect((await complete()).statusCode).toBe(200);
  expect((await c.repository.get('jobs', c.user.id, job.id))!.version).toBe(version);
  expect((await complete('wrong-lease')).statusCode).toBe(409);
  expect((await complete(job.lease, randomUUID())).statusCode).toBe(409);
  expect((await claim()).statusCode).toBe(409);
  const visible = (
    await c.app.inject({
      method: 'GET',
      url: `/execution/jobs/${job.id}`,
      headers: { authorization: c.user.authorization },
    })
  ).json();
  expect(visible).not.toHaveProperty('lastUpdateId');
  expect(visible).not.toHaveProperty('claimId');
});
