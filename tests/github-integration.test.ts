import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { githubContext, publishGitHub } from '../apps/cli/src/platform';
import { TaskManager, EventBus } from '../packages/agent-runtime/src';
import type { ExecutionJob } from '../apps/server/src/execution';

afterEach(() => vi.unstubAllEnvs());
const job = (): ExecutionJob => ({
  id: randomUUID(),
  owner: randomUUID(),
  workerId: randomUUID(),
  project: 'fixture',
  prompt: 'Review',
  options: { mode: 'plan', maxSteps: 30 },
  isolated: false,
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  commands: [],
  github: { repository: 'owner/project', number: 12, kind: 'pull_request', postResults: true },
});
it('retrieves a PR diff from the fixed GitHub endpoint as untrusted reference context', async () => {
  vi.stubEnv('GITHUB_TOKEN', 'fixture-github-token');
  const fetcher = vi.fn(async () => new Response('diff --git a/file.ts b/file.ts\n+verified'));
  expect(await githubContext(job(), fetcher as typeof fetch)).toContain('untrusted');
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.github.com/repos/owner/project/pulls/12',
    expect.objectContaining({ redirect: 'error' }),
  );
});
it('creates an opted-in result comment and updates the same marker on retry', async () => {
  vi.stubEnv('GITHUB_TOKEN', 'fixture-github-token');
  const task = new TaskManager().create('Review', '/fixture');
  task.status = 'completed';
  new EventBus(task).emit('agent.completed', {
    text: 'Finding in file.ts:12: concrete trigger and impact.',
  });
  const value = job();
  const writes: { url: string; init?: RequestInit }[] = [];
  let existing = false;
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method)
      return Response.json(existing ? [{ id: 101, body: `<!-- hikari-job:${value.id} -->` }] : []);
    writes.push({ url: String(url), init });
    existing = true;
    return Response.json({ id: 101 });
  });
  await publishGitHub(value, task, fetcher as typeof fetch);
  await publishGitHub(value, task, fetcher as typeof fetch);
  expect(writes.map((write) => write.init?.method)).toEqual(['POST', 'PATCH']);
  expect(writes[1]?.url).toBe('https://api.github.com/repos/owner/project/issues/comments/101');
  expect(JSON.parse(String(writes[0]?.init?.body)).body).toContain('file.ts:12');
});
it('publishes nothing without explicit opt-in and reports actual API failures', async () => {
  vi.stubEnv('GITHUB_TOKEN', 'fixture-github-token');
  const task = new TaskManager().create('Review', '/fixture');
  const value = job();
  value.github!.postResults = false;
  const fetcher = vi.fn(async () => Response.json({ error: 'denied' }, { status: 403 }));
  await publishGitHub(value, task, fetcher as typeof fetch);
  expect(fetcher).not.toHaveBeenCalled();
  value.github!.postResults = true;
  await expect(publishGitHub(value, task, fetcher as typeof fetch)).rejects.toThrow('403');
});
