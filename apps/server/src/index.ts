import { SQLiteRepository } from '@hikari/database';
import { PostgresRepository } from '@hikari/database/postgres';
import { createServer } from './app';
import { existsSync } from 'node:fs';
const repository = process.env.DATABASE_URL
  ? new PostgresRepository(process.env.DATABASE_URL)
  : new SQLiteRepository(
      process.env.SQLITE_PATH ??
        (existsSync('forge-server.sqlite') ? 'forge-server.sqlite' : 'hikari-server.sqlite'),
    );
if (repository instanceof PostgresRepository) await repository.migrate();
const server = await createServer(repository, process.env.REDIS_URL);
await server.listen({
  port: Number(process.env.PORT ?? 4318),
  host: process.env.HOST ?? '127.0.0.1',
});
console.log(
  `Hikari API listening at ${server.server.address() && JSON.stringify(server.server.address())}`,
);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void server.close());
