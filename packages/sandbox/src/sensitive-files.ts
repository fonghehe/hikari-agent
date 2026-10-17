import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { AgentError, sensitivePath } from '@hikari/agent-core';

export async function sensitiveFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [root];
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 1000000)
        throw new AgentError(
          'SENSITIVE_SCAN_LIMIT',
          'Workspace exceeds the sensitive-file scan limit; use a smaller workspace.',
        );
      const filename = path.join(directory, item.name);
      if (sensitivePath(path.relative(root, filename))) found.push(filename);
      else if (item.isDirectory()) pending.push(filename);
    }
  }
  return found;
}
