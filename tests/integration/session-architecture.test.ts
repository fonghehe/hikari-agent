import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SessionHost } from '../../packages/agent-host/src/index';
import { registerProjectKnowledge } from '../../packages/agent-host/src/project-knowledge';
import {
  sessionMemoryStore,
  ToolRegistry,
  SuperagentEngine,
  StateStore,
} from '../../packages/agent-runtime/src/index';
import { TaskHost } from '../../apps/desktop/src/main/tasks/task-host';
import { LocalPersistence } from '../../apps/desktop/src/main/storage/persistence';
import { modelConfigSchema } from '../../packages/shared/src/index';
import {
  runOptionsSchema,
  type ModelProvider,
  type ModelResponse,
} from '../../packages/agent-core/src/index';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function project() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-session-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'README.md'),
    '# Architecture\nThe astraldragon scheduler owns persistent work.\n',
  );
  return root;
}
function provider(chat: ModelProvider['chat']): ModelProvider {
  return {
    countTokens: () => 1,
    chat,
    async *stream(request) {
      yield await this.chat(request);
    },
  };
}

it('routes ordinary desktop and local-host tasks through the same authorized work lifecycle', async () => {
  const root = await project();
  const storage = new LocalPersistence(':memory:');
  cleanup.push(() => storage.close());
  const desktop = new TaskHost(() => {});
  desktop.initialize(storage);
  cleanup.push(async () => desktop.close());
  desktop.config = modelConfigSchema.parse({
    provider: 'compatible',
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'fixture',
    apiKey: '',
    streaming: false,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Inspected with fixture evidence.' } }],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
  const task = await desktop.start(
    'Inspect architecture',
    root,
    false,
    undefined,
    runOptionsSchema.parse({ mode: 'plan' }),
  );
  await vi.waitFor(() => {
    expect(task.status).toBe('completed');
    expect(desktop.runners.has(task.id)).toBe(false);
  });
  expect(task.mandate).toMatchObject({ strength: 'explicit', scope: task.prompt });
  expect(task.workItem?.stage).toBe('ended');
  expect(task.intent?.kind).toBe('plan');
  const engine = new SuperagentEngine(storage.controlStore(root));
  expect(engine.snapshot().tickets[0]?.outcome).toBe('completed');
  const local = new SessionHost({
    root,
    provider: provider(async () => ({ text: 'Inspected.', toolCalls: [] })),
  });
  cleanup.push(() => local.close());
  const other = await local.start('Inspect architecture', runOptionsSchema.parse({ mode: 'plan' }));
  await local.wait(other.id);
  expect(other.mandate?.strength).toBe(task.mandate?.strength);
  expect(other.workItem?.stage).toBe(task.workItem?.stage);
});

it('isolates project and conversation memory while sharing explicit user memory in desktop storage', () => {
  const storage = new LocalPersistence(':memory:');
  cleanup.push(() => storage.close());
  const a = sessionMemoryStore(storage.memories, '/project-a', 'conversation-a');
  const b = sessionMemoryStore(storage.memories, '/project-b', 'conversation-b');
  const now = new Date().toISOString();
  const user = {
    id: randomUUID(),
    title: 'Language',
    content: 'Use Chinese.',
    updatedAt: now,
    kind: 'user' as const,
  };
  a.put('', user);
  a.put('', {
    id: randomUUID(),
    title: 'Architecture',
    content: 'Use SQLite.',
    updatedAt: now,
    kind: 'project',
  });
  a.put('', {
    id: randomUUID(),
    title: 'Current task',
    content: 'Review the scheduler.',
    updatedAt: now,
    kind: 'conversation',
  });
  expect(a.list('')).toHaveLength(3);
  expect(b.list('').map((entry) => entry.title)).toEqual(['Language']);
  expect(a.list('').find((entry) => entry.kind === 'conversation')?.expiresAt).toBeTruthy();
  expect(() => a.put('', { ...user, kind: 'project' })).toThrow('cannot change its scope');
});

it('retrieves project citations and refuses deleted, changed, secret or escaping sources', async () => {
  const root = await project();
  const tools = new ToolRegistry();
  registerProjectKnowledge(tools, root);
  const context = {
    taskId: randomUUID(),
    workspace: root,
    signal: new AbortController().signal,
    events: { emit() {} },
  };
  const search = tools.get('search_project');
  const found = JSON.parse(
    (await search.execute(search.parse({ query: 'astraldragon', paths: ['README.md'] }), context))
      .content,
  );
  expect(found.results[0].path).toBe('README.md');
  const read = tools.get('read_project_source');
  expect(
    (await read.execute({ citationId: found.results[0].citationId }, context)).content,
  ).toContain('astraldragon');
  await writeFile(path.join(root, 'README.md'), 'Changed content');
  await expect(read.execute({ citationId: found.results[0].citationId }, context)).rejects.toThrow(
    'changed',
  );
  await writeFile(path.join(root, '.env'), 'PRIVATE_VALUE=not-for-indexing');
  expect(
    JSON.parse(
      (await search.execute(search.parse({ query: '', paths: ['.env'] }), context)).content,
    ).results,
  ).toHaveLength(0);
  await expect(
    search.execute(search.parse({ query: '', paths: ['../outside.md'] }), context),
  ).rejects.toThrow();
});

it('intent refinement can narrow execution but cannot authorize a later mutation', async () => {
  const root = await project();
  let step = 0;
  const replies: ModelResponse[] = [
    {
      text: '',
      toolCalls: [
        {
          id: 'intent',
          name: 'route_intent',
          input: { kind: 'research', reason: 'The user requested investigation.' },
        },
      ],
    },
    {
      text: '',
      toolCalls: [
        {
          id: 'write',
          name: 'write_file',
          input: { path: 'forbidden.txt', content: 'bad', expectedHash: null },
        },
      ],
    },
    { text: 'Research complete.', toolCalls: [] },
  ];
  const host = new SessionHost({
    root,
    provider: provider(async () => replies[step++]!),
    approve: async () => 'once',
  });
  cleanup.push(() => host.close());
  const task = await host.start(
    'Investigate the architecture',
    runOptionsSchema.parse({ requireTests: false }),
  );
  await host.wait(task.id);
  expect(task.intent?.kind).toBe('research');
  await expect(access(path.join(root, 'forbidden.txt'))).rejects.toThrow();
  expect(task.events.some((event) => event.type === 'tool.failed')).toBe(true);
});

it('persists a human pause across shutdown and only clears it on an explicit resume', async () => {
  const root = await project();
  const first = new SessionHost({
    root,
    provider: provider(
      async (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    ),
  });
  const task = await first.start('Inspect the project', runOptionsSchema.parse({ mode: 'plan' }));
  await vi.waitFor(() => expect(task.status).toBe('thinking'));
  first.runners.get(task.id)!.pause();
  const engine = new SuperagentEngine(new StateStore(root));
  expect(engine.snapshot().tickets[0]?.paused).toBe(true);
  await first.close();
  expect(engine.snapshot().tickets[0]?.paused).toBe(true);
  expect(task.events.some((event) => event.type === 'agent.resume_requested')).toBe(false);
  const second = new SessionHost({
    root,
    provider: provider(async () => ({ text: 'Inspection complete.', toolCalls: [] })),
  });
  cleanup.push(() => second.close());
  const saved = second.saved(task.id)!;
  await second.start(saved.prompt, saved.runOptions, false, saved);
  await second.wait(saved.id);
  expect(engine.snapshot().tickets[0]?.paused).toBe(false);
  expect(saved.status).toBe('completed');
});

it('keeps Plan retrieval local even when remote embeddings are configured', async () => {
  const root = await project();
  const config = modelConfigSchema.parse({
    provider: 'compatible',
    model: 'fixture',
    apiKey: '',
    embeddings: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'embedding-fixture',
      apiKey: '',
    },
  });
  const host = new SessionHost({
    root,
    retrieval: { embeddings: config.embeddings },
    provider: provider(async (request) => {
      expect(request.tools.map((tool) => tool.name)).toContain('search_project_local');
      expect(request.tools.map((tool) => tool.name)).not.toContain('search_project');
      expect(request.tools.map((tool) => tool.name)).not.toContain('search_memory');
      return { text: 'Local inspection complete.', toolCalls: [] };
    }),
  });
  cleanup.push(() => host.close());
  const task = await host.start('Inspect the project', runOptionsSchema.parse({ mode: 'plan' }));
  await host.wait(task.id);
  expect(task.status).toBe('completed');
});
