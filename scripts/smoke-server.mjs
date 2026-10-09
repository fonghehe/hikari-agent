import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root = await mkdtemp(path.join(tmpdir(), 'forge-built-api-'));
const child = spawn(process.execPath, ['apps/server/dist/index.mjs'], {
  env: {
    ...process.env,
    DATABASE_URL: '',
    REDIS_URL: '',
    PORT: '0',
    HOST: '127.0.0.1',
    SQLITE_PATH: path.join(root, 'api.sqlite'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stderr.on('data', (chunk) => {
  logs += String(chunk);
});
try {
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Built server did not start: ${logs}`)),
      10000,
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const match = /"port":(\d+)/.exec(output);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error(logs));
    });
  });
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  console.log('PASS: production server artifact started and responded to /health.');
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  await rm(root, { recursive: true, force: true });
}
