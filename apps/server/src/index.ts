import { SQLiteRepository } from '@hikari/database';
import { PostgresRepository } from '@hikari/database/postgres';
import { createServer } from './app';
import { existsSync } from 'node:fs';
import { z } from 'zod';
const repository = process.env.DATABASE_URL
  ? new PostgresRepository(process.env.DATABASE_URL)
  : new SQLiteRepository(
      process.env.SQLITE_PATH ??
        (existsSync('forge-server.sqlite') ? 'forge-server.sqlite' : 'hikari-server.sqlite'),
    );
if (repository instanceof PostgresRepository) await repository.migrate();
const server = await createServer(
  repository,
  process.env.REDIS_URL,
  {
    limits: {
      activeJobs: Number(process.env.HIKARI_MAX_ACTIVE_JOBS ?? 10),
      workers: Number(process.env.HIKARI_MAX_WORKERS ?? 5),
      maxTokens: Number(process.env.HIKARI_JOB_MAX_TOKENS ?? 200000),
      maxDurationMs: Number(process.env.HIKARI_JOB_MAX_MS ?? 1800000),
    },
    webhookSecret: process.env.HIKARI_GITHUB_WEBHOOK_SECRET,
    github: z
      .array(
        z.object({
          repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
          owner: z.string().uuid(),
          workerId: z.string().uuid(),
          project: z.string().regex(/^[\w-]{1,80}$/),
          allowedActors: z.array(z.string().min(1)).min(1),
          postResults: z.boolean().optional(),
        }),
      )
      .max(50)
      .parse(JSON.parse(process.env.HIKARI_GITHUB_ROUTES ?? '[]')),
  },
  { logging: true, token: process.env.HIKARI_OPS_TOKEN },
);
await server.listen({
  port: Number(process.env.PORT ?? 4318),
  host: process.env.HOST ?? '127.0.0.1',
});
console.log(
  `Hikari API listening at ${server.server.address() && JSON.stringify(server.server.address())}`,
);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void server.close());
