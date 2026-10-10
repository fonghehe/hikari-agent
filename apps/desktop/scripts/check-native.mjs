import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
if (process.env.HIKARI_NATIVE_PROBE === '1') {
  if (!process.versions.electron) throw new Error('Native modules must be checked in Electron');
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(':memory:');
  database.prepare('SELECT 1').get();
  database.close();
  const { createCanvas } = require('@napi-rs/canvas');
  const image = createCanvas(2, 2).toBuffer('image/png');
  const metadata = await require('sharp')(image).metadata();
  if (metadata.width !== 2) throw new Error('Native image processing failed');
  const ptyRoot = path.dirname(require.resolve('node-pty/package.json'));
  const { loadNativeModule } = require('node-pty/lib/utils');
  const native = loadNativeModule(process.platform === 'win32' ? 'conpty' : 'pty');
  if (process.platform === 'win32') {
    for (const file of ['conpty.dll', 'OpenConsole.exe'])
      await access(path.resolve(ptyRoot, 'lib', native.dir, 'conpty', file));
  }
  console.log(
    `Electron ${process.versions.electron}: SQLite, canvas, sharp and PTY native modules ready`,
  );
} else {
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HIKARI_NATIVE_PROBE: '1' },
    stdio: 'inherit',
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Electron native check failed: ${signal ?? code}`)),
    );
  });
}
