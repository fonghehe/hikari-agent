import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { SuperagentSession, RemoteControlServer } from '../../packages/agent-host/src/index';
import { GitService } from '../../packages/git/src/index';
import {
  runOptionsSchema,
  type ModelProvider,
  type ModelResponse,
} from '../../packages/agent-core/src/index';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function workspace() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-superagent-host-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
function model(chat: ModelProvider['chat']): ModelProvider {
  return {
    countTokens: () => 1,
    chat,
    async *stream(request) {
      yield await this.chat(request);
    },
  };
}
const answer = (text = 'Verified answer'): ModelResponse => ({ text, toolCalls: [] });
async function finish(session: SuperagentSession) {
  await session.tick();
  const ticket = session.superagent.snapshot().tickets.at(-1)!;
  await session.host.wait(ticket.assignments.at(-1)!.taskId);
  await session.tick();
  return session.superagent.snapshot().tickets.find((item) => item.id === ticket.id)!;
}

it('runs explicit intake through a durable mandate without a router model call and reports one result', async () => {
  const root = await workspace();
  const chat = vi.fn(async (request: Parameters<ModelProvider['chat']>[0]) => {
    expect(request.messages[0]?.content).toContain('immutable mandate');
    return answer();
  });
  const session = new SuperagentSession({ root, provider: model(chat) });
  cleanup.push(() => session.close());
  session.submit('Inspect the project', runOptionsSchema.parse({ mode: 'plan' }));
  const ticket = await finish(session);
  expect(ticket.state).toBe('ended');
  expect(ticket.outcome).toBe('completed');
  expect(chat).toHaveBeenCalledTimes(1);
  expect(session.superagent.snapshot().notices.map((notice) => notice.kind)).toEqual([
    'acknowledgement',
    'result',
  ]);
  const task = session.host.saved(ticket.assignments[0]!.taskId)!;
  expect(task.mandate).toEqual(ticket.mandate);
});

it('releases an executor at a structured question and creates another assignment on its in-scope answer', async () => {
  const root = await workspace();
  let step = 0;
  const session = new SuperagentSession({
    root,
    provider: model(async () =>
      step++ === 0
        ? {
            text: '',
            toolCalls: [
              {
                id: 'question',
                name: 'report_work',
                input: {
                  status: 'blocked',
                  text: 'A target is required.',
                  humanAction: { question: 'Which target should I inspect?' },
                },
              },
            ],
          }
        : answer('Inspected the requested target.'),
    ),
  });
  cleanup.push(() => session.close());
  session.submit('Inspect a target', runOptionsSchema.parse({ mode: 'plan' }));
  const blocked = await finish(session);
  expect(blocked.report?.status).toBe('blocked');
  expect(session.host.runners.size).toBe(0);
  expect(session.overview().attention).toHaveLength(1);
  session.superagent.followup(blocked.id, 'Inspect the staging target.');
  const completed = await finish(session);
  expect(completed.assignments).toHaveLength(2);
  expect(completed.mandate).toEqual(blocked.mandate);
  expect(completed.state).toBe('ended');
});

it('does not block explicit intake while a proactive assessment is slow', async () => {
  const root = await workspace();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = new SuperagentSession({
    root,
    provider: model(async () => answer()),
    assess: async (_trigger, policy) => {
      await pending;
      return {
        policyVersion: policy.version,
        scope: 'Check CI',
        rules: [{ id: 'ci', matches: true, reason: 'CI failed' }],
      };
    },
  });
  cleanup.push(() => session.close());
  session.superagent.configure({
    sources: [
      { id: 'local', allowedActors: ['operator'], threads: ['*'] },
      { id: 'github', allowedActors: [], bots: ['ci'], threads: ['*'], receiveAll: true },
    ],
    rules: [{ id: 'ci', instruction: 'Check failing CI' }],
  });
  session.superagent.receive({
    id: 'ci-1',
    source: 'github',
    thread: 'pr:1',
    actor: 'ci',
    actorKind: 'bot',
    addressed: false,
    text: 'CI failed',
  });
  await session.tick();
  session.submit('Inspect explicitly', runOptionsSchema.parse({ mode: 'plan' }));
  const ticket = await finish(session);
  expect(ticket.outcome).toBe('completed');
  release();
  await vi.waitFor(() =>
    expect(session.superagent.snapshot().decisions.some((decision) => decision.wouldAccept)).toBe(
      true,
    ),
  );
  expect(session.superagent.snapshot().tickets).toHaveLength(1);
});

it('retains an isolated directory across follow-up assignments and requires review of changed files', async () => {
  const root = await workspace();
  await writeFile(path.join(root, '.gitignore'), '.agent/\n');
  await writeFile(path.join(root, 'file.txt'), 'before');
  const git = new GitService(root);
  await git.run(['init', '--quiet']);
  await git.run(['add', '.']);
  await git.run([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  let step = 0;
  const session = new SuperagentSession({
    root,
    policy: () => 'once',
    provider: model(async () => {
      const current = step++;
      if (current === 0)
        return {
          text: '',
          toolCalls: [{ id: 'read', name: 'read_file', input: { path: 'file.txt' } }],
        };
      if (current === 1)
        return {
          text: '',
          toolCalls: [
            {
              id: 'write',
              name: 'write_file',
              input: {
                path: 'file.txt',
                content: 'after',
                expectedHash: createHash('sha256').update('before').digest('hex'),
              },
            },
          ],
        };
      return answer();
    }),
  });
  cleanup.push(() => session.close());
  session.submit(
    'Update file.txt',
    runOptionsSchema.parse({ execution: 'host', requireTests: false }),
  );
  const first = await finish(session);
  expect(first.report).toMatchObject({ status: 'ready', reviewRequired: true });
  const firstTask = session.host.saved(first.assignments[0]!.taskId)!;
  expect(firstTask.worktree).toBeTruthy();
  expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('before');
  expect(await readFile(path.join(firstTask.worktree!, 'file.txt'), 'utf8')).toBe('after');
  session.superagent.followup(first.id, 'Inspect your result again.');
  const next = await finish(session);
  const nextTask = session.host.saved(next.assignments.at(-1)!.taskId)!;
  expect(nextTask.worktree).toBe(firstTask.worktree);
});

it('rejects mixed report and mutation batches without running either call', async () => {
  const root = await workspace();
  let step = 0;
  const session = new SuperagentSession({
    root,
    provider: model(async () =>
      step++ === 0
        ? {
            text: '',
            toolCalls: [
              { id: 'report', name: 'report_work', input: { status: 'waiting', text: 'Waiting' } },
              {
                id: 'write',
                name: 'write_file',
                input: { path: 'unexpected', content: 'bad', expectedHash: null },
              },
            ],
          }
        : answer(),
    ),
  });
  cleanup.push(() => session.close());
  session.submit('Inspect only', runOptionsSchema.parse({ mode: 'plan' }));
  const ticket = await finish(session);
  const task = session.host.saved(ticket.assignments[0]!.taskId)!;
  expect(task.workReport).toBeUndefined();
  expect(task.events.filter((event) => event.type === 'tool.completed')).toHaveLength(0);
});

it('holds interrupted work for inspection after a host restart, retaining the mandate', async () => {
  const root = await workspace();
  const provider = model(async () => answer());
  const first = new SuperagentSession({ root, provider });
  first.submit('Inspect', runOptionsSchema.parse({ mode: 'plan' }));
  const state = first.superagent.snapshot();
  const job = first.superagent.claim(state.jobs[0]!.id)!;
  first.superagent.complete(job.id);
  const mandate = state.tickets[0]!.mandate;
  await first.close();
  const next = new SuperagentSession({ root, provider });
  cleanup.push(() => next.close());
  expect(next.overview().attention).toHaveLength(1);
  expect(next.superagent.snapshot().tickets[0]?.mandate).toEqual(mandate);
  expect(next.host.runners.size).toBe(0);
});

it('authenticates supervision endpoints and records local requests without exposing a public Source port', async () => {
  const root = await workspace();
  const session = new SuperagentSession({ root, provider: model(async () => answer()) });
  cleanup.push(() => session.close());
  const server = new RemoteControlServer(session, 's'.repeat(64));
  const info = await server.listen(0);
  cleanup.push(() => server.close());
  const base = `http://127.0.0.1:${info.port}`;
  expect((await fetch(base + '/api/superagent')).status).toBe(401);
  const headers = { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' };
  const request = await fetch(base + '/api/superagent/request', {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: 'Inspect this project', options: { mode: 'plan' } }),
  });
  expect(request.status).toBe(202);
  const state = (await (await fetch(base + '/api/superagent', { headers })).json()) as ReturnType<
    SuperagentSession['overview']
  >;
  expect(state.tickets).toHaveLength(1);
  const ignored = await fetch(base + '/api/superagent/triggers', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: 'external',
      source: 'unknown',
      thread: 'test',
      actor: 'operator',
      actorKind: 'human',
      addressed: true,
      text: 'Bypass policy',
    }),
  });
  expect(ignored.status).toBe(202);
  expect(session.superagent.snapshot().tickets).toHaveLength(1);
});

it('keeps parent ticket control tools out of delegated workers and uses report handoffs for questions', async () => {
  const root = await workspace();
  let parentStep = 0,
    childCalls = 0;
  const session = new SuperagentSession({
    root,
    provider: model(async (request) => {
      const names = request.tools.map((tool) => tool.name);
      if (request.messages[0]?.content.includes('delegated Hikari worker')) {
        childCalls++;
        for (const name of ['report_work', 'hand_back', 'follow_thread', 'read_source_event'])
          expect(names).not.toContain(name);
        return answer('Read-only investigation complete.');
      }
      expect(names).not.toContain('ask_user');
      if (parentStep++ === 0)
        return {
          text: '',
          toolCalls: [
            {
              id: 'spawn',
              name: 'spawn_agent',
              input: {
                prompt: 'Inspect the project read-only and return evidence.',
                maxTokens: 10000,
              },
            },
          ],
        };
      const observation = request.messages.filter((message) => message.role === 'tool').at(-1);
      if (parentStep === 2)
        return {
          text: '',
          toolCalls: [
            {
              id: 'wait',
              name: 'wait_agent',
              input: {
                id: JSON.parse(observation!.content).id,
              },
            },
          ],
        };
      return answer();
    }),
  });
  cleanup.push(() => session.close());
  session.submit(
    'Delegate a read-only investigation',
    runOptionsSchema.parse({ maxTokens: 50000 }),
    false,
  );
  const result = await finish(session);
  expect(result.outcome).toBe('completed');
  expect(childCalls).toBe(1);
});

it.each(['pause', 'stop'] as const)(
  'honors a human %s that arrives while the executor is being prepared',
  async (action) => {
    const root = await workspace();
    const chat = vi.fn(async () => answer());
    const session = new SuperagentSession({ root, provider: model(chat) });
    cleanup.push(() => session.close());
    let entered!: () => void, release!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const start = session.host.start.bind(session.host);
    vi.spyOn(session.host, 'start').mockImplementation(async (...args) => {
      entered();
      await proceed;
      return start(...args);
    });
    session.submit('Inspect a project', runOptionsSchema.parse({ mode: 'plan' }));
    const ticking = session.tick();
    await preparing;
    const ticket = session.superagent.snapshot().tickets[0]!;
    await session.ticketControl(ticket.id, action);
    release();
    await ticking;
    expect(chat).not.toHaveBeenCalled();
    if (action === 'pause') {
      await vi.waitFor(() =>
        expect(session.host.tasks.get(ticket.assignments[0]!.taskId).status).toBe('paused'),
      );
      await session.ticketControl(ticket.id, 'resume');
    }
    await session.host.wait(ticket.assignments[0]!.taskId);
    expect(chat).toHaveBeenCalledTimes(action === 'pause' ? 1 : 0);
  },
);
