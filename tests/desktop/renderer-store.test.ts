import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../packages/agent-core/src/index';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());
const event = (id: string, state = 'thinking'): AgentEvent => ({
  id,
  taskId: 'task',
  agentId: 'agent',
  timestamp: '2026-01-01T00:00:00Z',
  type: 'agent.state',
  data: { state },
});
it('coalesces synchronous state bursts without deferring critical events or their task state', async () => {
  let reads = 0;
  vi.stubGlobal('window', {
    hikari: {
      agent: {
        list: async () => {
          reads++;
          return [];
        },
      },
    },
  });
  const { useStore } = await import('../../apps/desktop/src/renderer/app/store');
  useStore.setState({
    tasks: [
      {
        id: 'task',
        agentId: 'agent',
        title: 'Fixture',
        prompt: 'Fixture',
        workspace: '/fixture',
        status: 'thinking',
        createdAt: '',
        updatedAt: '',
        events: [],
      },
    ],
  });
  for (let i = 0; i < 100; i++)
    useStore.getState().receive(event(String(i), i === 99 ? 'failed' : 'thinking'));
  expect(useStore.getState().events.at(-1)?.data.state).toBe('failed');
  expect(useStore.getState().tasks[0]?.status).toBe('failed');
  await useStore.getState().refresh();
  expect(reads).toBe(1);
});
it('discards an obsolete list response and fetches again when an event arrives during the request', async () => {
  let complete: ((value: []) => void) | undefined;
  let reads = 0;
  vi.stubGlobal('window', {
    hikari: {
      agent: {
        list: () => {
          reads++;
          return reads === 1
            ? new Promise<[]>((resolve) => {
                complete = resolve;
              })
            : Promise.resolve([]);
        },
      },
    },
  });
  const { useStore } = await import('../../apps/desktop/src/renderer/app/store');
  const pending = useStore.getState().refresh();
  await Promise.resolve();
  useStore.getState().receive(event('new'));
  complete!([]);
  await pending;
  expect(reads).toBe(2);
  expect(useStore.getState().events.map((value) => value.id)).toEqual(['new']);
});
it('does not restore an old startup workspace after the user explicitly cleared the selection', async () => {
  let finish: ((workspace: { root: string; name: string; files: string[] }) => void) | undefined;
  let savedRoot: string | null = '/old';
  vi.stubGlobal('window', {
    hikari: {
      workspace: {
        snapshot: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        clear: async () => {
          savedRoot = null;
        },
      },
    },
  });
  const { useStore } = await import('../../apps/desktop/src/renderer/app/store');
  const restore = useStore.getState().restoreWorkspace();
  await useStore.getState().selectWorkspace(null);
  finish!({ root: '/old', name: 'Old', files: [] });
  await restore;
  expect(useStore.getState().workspace).toBeNull();
  expect(savedRoot).toBeNull();
});
it('still consumes a queued refresh when the in-flight list request fails', async () => {
  let fail: ((error: Error) => void) | undefined;
  let reads = 0;
  vi.stubGlobal('window', {
    hikari: {
      agent: {
        list: () =>
          ++reads === 1
            ? new Promise((_, reject) => {
                fail = reject;
              })
            : Promise.resolve([]),
      },
    },
  });
  const { useStore } = await import('../../apps/desktop/src/renderer/app/store');
  const first = useStore.getState().refresh();
  await Promise.resolve();
  const trailing = useStore.getState().refresh();
  fail!(new Error('Temporary IPC failure'));
  await Promise.all([first, trailing]);
  expect(reads).toBe(2);
});
