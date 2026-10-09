import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { Redis } from 'ioredis';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { runOptionsSchema, taskPlanSchema, runSummarySchema, redact } from '@hikari/agent-core';
import { ConflictError, type Repository } from '@hikari/database';
const derive = promisify(scrypt);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const credentials = z.object({
  email: z
    .string()
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(256),
});
const snapshot = z.object({
  id: z.string().uuid(),
  agentId: z.string(),
  title: z.string().max(200),
  prompt: z.string().max(24000),
  status: z.enum([
    'idle',
    'planning',
    'thinking',
    'executing_tool',
    'waiting_permission',
    'waiting_input',
    'interrupted',
    'observing',
    'paused',
    'completed',
    'failed',
    'cancelled',
  ]),
  createdAt: z.string(),
  updatedAt: z.string(),
  workspace: z.string(),
  worktree: z.string().optional(),
  parentTaskId: z.string().uuid().optional(),
  demo: z.boolean().optional(),
  chat: z.boolean().optional(),
  archived: z.boolean().optional(),
  modelIdentity: z
    .object({ provider: z.string(), model: z.string(), baseUrl: z.string().optional() })
    .optional(),
  runOptions: runOptionsSchema.optional(),
  plan: taskPlanSchema.optional(),
  runSummary: runSummarySchema.optional(),
  events: z
    .array(
      z.object({
        id: z.string(),
        taskId: z.string(),
        agentId: z.string(),
        type: z.string(),
        timestamp: z.string(),
        data: z.record(z.unknown()),
      }),
    )
    .max(2000),
});
interface Account {
  id: string;
  email: string;
  salt: string;
  passwordHash: string;
}
interface Session {
  userId: string;
  expires: number;
}
export async function createServer(repository: Repository, redisUrl?: string) {
  const app = Fastify({ bodyLimit: 4 * 1024 * 1024, logger: false });
  const redis = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: 1 }) : undefined;
  await app.register(rateLimit, { max: 60, timeWindow: '1 minute', ...(redis ? { redis } : {}) });
  await app.register(websocket);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: 'Invalid request',
        issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    const status = (error as { statusCode?: number }).statusCode;
    return reply
      .code(status ?? 500)
      .send({ error: status && status < 500 ? (error as Error).message : 'Internal server error' });
  });
  async function authenticate(header: unknown) {
    if (typeof header !== 'string' || !header.startsWith('Bearer '))
      throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
    const record = await repository.get('sessions', 'auth', digest(header.slice(7)));
    const session = record?.data as Session | undefined;
    if (!session || session.expires < Date.now())
      throw Object.assign(new Error('Session expired'), { statusCode: 401 });
    return session.userId;
  }
  const listeners = new Map<string, Set<(data: Record<string, unknown>) => void>>();
  const deliver = (owner: string, data: Record<string, unknown>) => {
    for (const listener of listeners.get(owner) ?? []) listener(data);
  };
  const subscriber = redis?.duplicate();
  if (subscriber) {
    subscriber.on('message', (_channel, message) => {
      try {
        const event = z
          .object({ owner: z.string(), data: z.record(z.unknown()) })
          .safeParse(JSON.parse(message) as unknown);
        if (event.success) deliver(event.data.owner, event.data.data);
      } catch {
        /* Ignore malformed messages from unrelated Redis publishers. */
      }
    });
    await subscriber.subscribe('forge:task-updates');
  }
  const publish = async (owner: string, data: Record<string, unknown>) => {
    if (redis) await redis.publish('forge:task-updates', JSON.stringify({ owner, data }));
    else deliver(owner, data);
  };
  app.get('/health', async () => ({ status: 'ok', mode: redis ? 'redis' : 'single-process' }));
  app.post(
    '/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = credentials.parse(request.body);
      const salt = randomBytes(16).toString('hex');
      const key = (await derive(input.password, salt, 64)) as Buffer;
      const account: Account = {
        id: randomUUID(),
        email: input.email,
        salt,
        passwordHash: key.toString('hex'),
      };
      await repository.put('users', 'auth', input.email, account, 0);
      return reply.code(201).send({ id: account.id, email: account.email });
    },
  );
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = credentials.parse(request.body);
      const account = (await repository.get('users', 'auth', input.email))?.data as
        | Account
        | undefined;
      const key = (await derive(
        input.password,
        account?.salt ?? 'unregistered-account',
        64,
      )) as Buffer;
      if (!account || !timingSafeEqual(key, Buffer.from(account.passwordHash, 'hex')))
        return reply.code(401).send({ error: 'Invalid credentials' });
      const token = randomBytes(32).toString('hex');
      await repository.put(
        'sessions',
        'auth',
        digest(token),
        { userId: account.id, expires: Date.now() + 7 * 86400000 },
        0,
      );
      return { token, user: { id: account.id, email: account.email } };
    },
  );
  app.post('/auth/logout', async (request) => {
    await authenticate(request.headers.authorization);
    await repository.remove('sessions', 'auth', digest(request.headers.authorization!.slice(7)));
    return { ok: true };
  });
  app.get('/tasks', async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(500),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);
    return repository.list('tasks', await authenticate(request.headers.authorization), query);
  });
  app.put('/tasks/:id', async (request) => {
    const owner = await authenticate(request.headers.authorization);
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    const body = z
      .object({ expectedVersion: z.number().int().nonnegative(), task: snapshot })
      .parse(request.body);
    if (body.task.id !== id)
      throw Object.assign(new Error('Task ID mismatch'), { statusCode: 400 });
    const task = redact(body.task);
    const saved = await repository.put('tasks', owner, id, task, body.expectedVersion);
    await publish(owner, { type: 'task.synced', id, version: saved.version });
    return saved;
  });
  app.get('/events', async (request, reply) => {
    const owner = await authenticate(request.headers.authorization);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reply.raw.write(
      `event: ready\ndata: ${JSON.stringify({ message: 'Fetch /tasks for current snapshots; this stream reports subsequent changes.' })}\n\n`,
    );
    const listener = (data: Record<string, unknown>) => {
      void authenticate(request.headers.authorization)
        .then(() => {
          if (!reply.raw.write(`event: change\ndata: ${JSON.stringify(data)}\n\n`))
            reply.raw.destroy();
        })
        .catch(() => reply.raw.destroy());
    };
    const set = listeners.get(owner) ?? new Set();
    set.add(listener);
    listeners.set(owner, set);
    const timer = setInterval(() => reply.raw.write(': heartbeat\n\n'), 20000);
    reply.raw.on('close', () => {
      clearInterval(timer);
      set.delete(listener);
      if (!set.size) listeners.delete(owner);
    });
  });
  app.get(
    '/ws',
    {
      websocket: true,
      preValidation: async (request) => {
        await authenticate(request.headers.authorization);
      },
    },
    (socket, request) => {
      let cleanup = () => {};
      let closed = false;
      socket.on('close', () => {
        closed = true;
        cleanup();
      });
      void authenticate(request.headers.authorization)
        .then((owner) => {
          if (closed) return;
          const listener = (data: Record<string, unknown>) => {
            if (socket.bufferedAmount > 1024 * 1024) {
              socket.close(1013, 'Slow consumer');
              return;
            }
            void authenticate(request.headers.authorization)
              .then(() => {
                if (socket.readyState === 1) socket.send(JSON.stringify(data));
              })
              .catch(() => socket.close(1008, 'Session expired'));
          };
          const set = listeners.get(owner) ?? new Set();
          set.add(listener);
          listeners.set(owner, set);
          cleanup = () => {
            set.delete(listener);
            if (!set.size) listeners.delete(owner);
          };
          socket.send(JSON.stringify({ type: 'ready' }));
        })
        .catch(() => socket.close(1008, 'Unauthorized'));
    },
  );
  app.addHook('onClose', async () => {
    subscriber?.disconnect();
    redis?.disconnect();
    await repository.close();
  });
  return app;
}
