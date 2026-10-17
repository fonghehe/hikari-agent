import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SQLiteRepository } from '../packages/database/src';
import { StateStore } from '../packages/agent-runtime/src';
import { createServer as createAPI } from '../apps/server/src/app';

it('reconnects after lost claim, heartbeat and completion responses without replaying the model task', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-worker-')));
  await writeFile(path.join(root, 'file.txt'), 'worker fixture');
  const app = await createAPI(new SQLiteRepository(':memory:'));
  const dropped = new Set<string>();
  app.addHook('onSend', async (request, reply, payload) => {
    const body = request.body as { status?: string } | undefined;
    const kind =
      request.url === '/worker/claim'
        ? 'claim'
        : request.url.startsWith('/worker/jobs/')
          ? body?.status
          : undefined;
    if (kind && reply.statusCode === 200 && !dropped.has(kind)) {
      dropped.add(kind);
      // Database mutations have completed, but the client receives no response.
      reply.raw.destroy();
    }
    return payload;
  });
  let calls = 0;
  const model = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    calls++;
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        choices: [
          {
            message:
              calls === 1
                ? {
                    content: '',
                    tool_calls: [
                      {
                        id: 'read-fixture',
                        type: 'function',
                        function: {
                          name: 'read_file',
                          arguments: JSON.stringify({ path: 'file.txt' }),
                        },
                      },
                    ],
                  }
                : { content: 'Inspected file.txt in the registered worker project.' },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
  });
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(),
      modelAddress = model.address();
    if (
      !address ||
      typeof address === 'string' ||
      !modelAddress ||
      typeof modelAddress === 'string'
    )
      throw new Error('Missing fixture port');
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'worker@example.test', password: 'worker-fixture-password' },
    });
    const login = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'worker@example.test', password: 'worker-fixture-password' },
      })
    ).json();
    const authorization = 'Bearer ' + login.token;
    const worker = (
      await app.inject({
        method: 'POST',
        url: '/execution/workers',
        headers: { authorization },
        payload: { name: 'fixture worker', projects: ['fixture'] },
      })
    ).json();
    const job = (
      await app.inject({
        method: 'POST',
        url: '/execution/jobs',
        headers: { authorization },
        payload: {
          workerId: worker.id,
          project: 'fixture',
          prompt: 'Inspect file.txt without editing.',
          options: { mode: 'plan' },
          isolated: false,
        },
      })
    ).json();
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith('AGENT_') || key.startsWith('HIKARI_') || key.startsWith('GITHUB_'))
        delete env[key];
    Object.assign(env, {
      HIKARI_SERVER_URL: `http://127.0.0.1:${address.port}`,
      HIKARI_WORKER_TOKEN: worker.workerToken,
      HIKARI_WORKER_PROJECTS: JSON.stringify({ fixture: root }),
      AGENT_WORKSPACE: root,
      AGENT_PROVIDER: 'compatible',
      AGENT_MODEL: 'explicit-worker-fixture',
      AGENT_BASE_URL: `http://127.0.0.1:${modelAddress.port}/v1`,
      AGENT_STREAMING: 'false',
    });
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.resolve('apps/cli/src/index.ts'), 'worker', 'run', '--once'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    }).finally(() => clearTimeout(timeout));
    expect(exit, output).toBe(0);
    const saved = (
      await app.inject({
        method: 'GET',
        url: `/execution/jobs/${job.id}`,
        headers: { authorization },
      })
    ).json();
    expect(saved.status, JSON.stringify(saved)).toBe('completed');
    expect(
      saved.task.events.some((event: { type: string }) => event.type === 'tool.completed'),
    ).toBe(true);
    expect(new StateStore(root).get<{ status: string }>(`cloud-${job.id}`)?.status).toBe(
      'completed',
    );
    expect(calls).toBe(2);
    expect([...dropped].sort()).toEqual(['claim', 'completed', 'running']);
    expect(output).toContain('reconnect attempt');
  } finally {
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
