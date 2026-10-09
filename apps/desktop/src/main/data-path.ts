import { existsSync } from 'node:fs';
import path from 'node:path';

export function desktopDataPath(appData: string, previousUserData: string, override?: string) {
  const candidates = [
    path.join(appData, 'Hikari'),
    previousUserData,
    path.join(appData, 'Forge'),
    path.join(appData, '@forge', 'desktop'),
  ];
  const hasDatabase = (directory: string) =>
    ['hikari.sqlite', 'forge.sqlite'].some((file) => existsSync(path.join(directory, file)));
  const directory = override
    ? path.resolve(override)
    : (candidates.find(hasDatabase) ?? candidates[0]!);
  const database = existsSync(path.join(directory, 'hikari.sqlite'))
    ? 'hikari.sqlite'
    : existsSync(path.join(directory, 'forge.sqlite'))
      ? 'forge.sqlite'
      : 'hikari.sqlite';
  return { directory, database: path.join(directory, database) };
}
