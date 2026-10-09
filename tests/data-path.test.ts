import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { desktopDataPath } from '../apps/desktop/src/main/data-path';

describe('Hikari data compatibility', () => {
  it('reuses old databases without copying and prioritizes explicit or current Hikari data', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hikari-data-path-'));
    const oldDevelopment = path.join(root, '@forge/desktop');
    const oldApplication = path.join(root, 'Forge');
    const current = path.join(root, 'Hikari');
    const override = path.join(root, 'explicit');
    try {
      expect(desktopDataPath(root, oldDevelopment)).toEqual({
        directory: current,
        database: path.join(current, 'hikari.sqlite'),
      });
      await mkdir(oldDevelopment, { recursive: true });
      await writeFile(path.join(oldDevelopment, 'forge.sqlite'), 'old-data');
      expect(desktopDataPath(root, oldDevelopment).database).toBe(
        path.join(oldDevelopment, 'forge.sqlite'),
      );
      await mkdir(oldApplication);
      await writeFile(path.join(oldApplication, 'forge.sqlite'), 'old-packaged-data');
      expect(desktopDataPath(root, path.join(root, 'unused')).database).toBe(
        path.join(oldApplication, 'forge.sqlite'),
      );
      await mkdir(current);
      await writeFile(path.join(current, 'hikari.sqlite'), 'current-data');
      expect(desktopDataPath(root, oldDevelopment).directory).toBe(current);
      expect(desktopDataPath(root, oldDevelopment, override).directory).toBe(override);
      await mkdir(override);
      await writeFile(path.join(override, 'forge.sqlite'), 'explicit-legacy-data');
      expect(desktopDataPath(root, oldDevelopment, override).database).toBe(
        path.join(override, 'forge.sqlite'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
