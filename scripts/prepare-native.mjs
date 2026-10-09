import { createRequire } from 'node:module';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
if (process.platform !== 'win32') {
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const relative of [
    `prebuilds/${process.platform}-${process.arch}/spawn-helper`,
    'build/Release/spawn-helper',
  ]) {
    try {
      await chmod(path.join(root, relative), 0o755);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
