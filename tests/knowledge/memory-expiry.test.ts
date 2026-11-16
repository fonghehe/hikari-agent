import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ToolRegistry,
  registerMemoryTools,
  type MemoryEntry,
} from '../../packages/agent-runtime/src/index';
import type { ToolContext } from '../../packages/agent-core/src/index';
import { LocalPersistence } from '../../apps/desktop/src/main/storage/persistence';

it('reclaims expired memories only when adding a new fact in the same full scope', async () => {
  const store = new LocalPersistence(':memory:');
  const entry: MemoryEntry = {
    id: randomUUID(),
    title: 'Keep',
    content: 'valid',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  try {
    store.memories.put('other', entry);
    store.memories.put('project', entry);
    for (let i = 0; i < 99; i++)
      store.memories.put('project', {
        ...entry,
        id: randomUUID(),
        expiresAt: '2000-01-01T00:00:00Z',
      });
    const registry = new ToolRegistry();
    registerMemoryTools(registry, store.memories, 'project');
    await registry
      .get('remember')
      .execute({ title: 'New', content: 'new fact' }, {} as ToolContext);
    expect(store.memories.list('project').map((item) => item.title)).toEqual(['Keep', 'New']);
    expect(store.memories.list('other')).toEqual([entry]);
  } finally {
    await store.close();
  }
});
