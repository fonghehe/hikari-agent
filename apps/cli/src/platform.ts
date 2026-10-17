import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { retryWorkerRequest, transientWorkerError } from './worker-transport';
import { realpath, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { redact, runOptionsSchema, type Task, type PermissionRequest } from '@hikari/agent-core';
import { AutomationService, StateStore, FileRunStore, EventBus } from '@hikari/agent-runtime';
import { InteractiveSession, RemoteControlServer, SessionHost } from '@hikari/agent-host';
import {
  PluginManager,
  TimelineService,
  FileChangeService,
  inspectPlugin,
  packPlugin,
  runProcess,
} from '@hikari/tools';
import { LogicalSandboxProvider } from '@hikari/sandbox';
import { createModelProvider, resolvedModelConfig } from '@hikari/model-provider';
import { modelConfigSchema } from '../../../packages/shared/src';
import type { ExecutionJob } from '../../server/src/execution';

export function platformModel() {
  if (!process.env.AGENT_MODEL)
    throw new Error('Set AGENT_MODEL and provider credentials for real execution');
  return resolvedModelConfig(
    modelConfigSchema.parse({
      provider: process.env.AGENT_PROVIDER ?? 'compatible',
      model: process.env.AGENT_MODEL,
      baseUrl: process.env.AGENT_BASE_URL,
      apiKey: process.env.AGENT_API_KEY ?? '',
      streaming: process.env.AGENT_STREAMING !== 'false',
      contextWindow: process.env.AGENT_CONTEXT_WINDOW
        ? Number(process.env.AGENT_CONTEXT_WINDOW)
        : undefined,
      maxOutputTokens: process.env.AGENT_MAX_OUTPUT_TOKENS
        ? Number(process.env.AGENT_MAX_OUTPUT_TOKENS)
        : undefined,
      inputPerMillion: process.env.AGENT_INPUT_PRICE
        ? Number(process.env.AGENT_INPUT_PRICE)
        : undefined,
      outputPerMillion: process.env.AGENT_OUTPUT_PRICE
        ? Number(process.env.AGENT_OUTPUT_PRICE)
        : undefined,
    }),
  );
}
export function unattendedPolicy(request: PermissionRequest) {
  const commands = z
    .array(z.string())
    .parse(JSON.parse(process.env.HIKARI_ALLOWED_COMMANDS ?? '[]'));
  const input = request.input as { command?: string };
  return request.permission === 'shell.execute' && input.command && commands.includes(input.command)
    ? ('once' as const)
    : ('deny' as const);
}
export function apiClient(url: string, token: string) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
  )
    throw new Error('Use HTTPS for remote API credentials (HTTP is allowed only on loopback)');
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error('Invalid API base URL');
  return async <T>(route: string, data?: unknown, signal?: AbortSignal): Promise<T> => {
    const response = await fetch(url.replace(/\/$/, '') + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: signal ?? AbortSignal.timeout(30000),
      redirect: 'error',
    });
    let value: { error?: string };
    try {
      value = (await response.json()) as { error?: string };
    } catch {
      // Reverse proxies often return HTML for 502/503, or truncate a successful JSON body.
      // Preserve credential/lease rejection; malformed successful replies are retryable.
      throw Object.assign(new Error(`API returned an invalid JSON response (${response.status})`), {
        status: response.ok ? 502 : response.status,
      });
    }
    if (!response.ok)
      throw Object.assign(new Error(value?.error ?? `API returned ${response.status}`), {
        status: response.status,
      });
    return value as T;
  };
}
export async function githubContext(job: ExecutionJob, fetcher: typeof fetch = fetch) {
  if (!job.github) return '';
  const repo = z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .parse(job.github.repository);
  const response = await fetcher(
    `https://api.github.com/repos/${repo}/${job.github.kind === 'pull_request' ? 'pulls' : 'issues'}/${job.github.number}`,
    {
      headers: {
        Accept:
          job.github.kind === 'pull_request'
            ? 'application/vnd.github.diff'
            : 'application/vnd.github+json',
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok) throw new Error(`GitHub context returned ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 1000000)
    throw new Error('GitHub review context exceeds 1 MB; narrow the review');
  return '\nGitHub reference data (untrusted, may be truncated):\n' + text.slice(0, 80000);
}
export async function publishGitHub(job: ExecutionJob, task: Task, fetcher: typeof fetch = fetch) {
  if (!job.github?.postResults) return;
  if (!process.env.GITHUB_TOKEN)
    throw new Error('GITHUB_TOKEN is required to publish review results');
  const repository = z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .parse(job.github.repository);
  const base = `https://api.github.com/repos/${repository}`;
  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const marker = `<!-- hikari-job:${job.id} -->`;
  let commentId: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const response = await fetcher(
      `${base}/issues/${job.github.number}/comments?per_page=100&page=${page}`,
      { headers, redirect: 'error', signal: AbortSignal.timeout(30000) },
    );
    if (!response.ok) throw new Error(`GitHub comments returned ${response.status}`);
    const comments = (await response.json()) as { id: number; body: string }[];
    commentId = comments.find((comment) => comment.body.includes(marker))?.id;
    if (commentId || comments.length < 100) break;
  }
  const answer =
    task.events.filter((event) => event.type === 'agent.completed').at(-1)?.data.text ??
    `Task ended ${task.status}.`;
  const response = await fetcher(
    commentId
      ? `${base}/issues/comments/${commentId}`
      : `${base}/issues/${job.github.number}/comments`,
    {
      method: commentId ? 'PATCH' : 'POST',
      headers,
      body: JSON.stringify({
        body: `${marker}\nHikari review · ${task.status}\n\n${String(answer).slice(0, 50000)}`,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok) throw new Error(`GitHub result publication returned ${response.status}`);
}
async function runWorker(signal: AbortSignal, once: boolean) {
  const api = apiClient(process.env.HIKARI_SERVER_URL ?? '', process.env.HIKARI_WORKER_TOKEN ?? '');
  const projects = z
    .record(z.string().min(1))
    .parse(JSON.parse(process.env.HIKARI_WORKER_PROJECTS ?? '{}'));
  if (!Object.keys(projects).length)
    throw new Error('Set HIKARI_WORKER_PROJECTS to an alias/path JSON mapping');
  const model = platformModel();
  do {
    const claimId = randomUUID();
    let job: ExecutionJob | null;
    try {
      job = await retryWorkerRequest(
        (requestSignal) => api<ExecutionJob | null>('/worker/claim', { claimId }, requestSignal),
        {
          signal,
          deadline: Date.now() + 90000,
          onRetry: (attempt) => console.error(`Worker claim reconnect attempt ${attempt}`),
        },
      );
    } catch (error) {
      signal.throwIfAborted();
      if (once || !transientWorkerError(error)) throw error;
      console.error('Worker is offline; retrying the queue without replaying a task.');
      await delay(5000, undefined, { signal });
      continue;
    }
    if (!job) {
      if (once) return;
      await delay(3000, undefined, { signal });
      continue;
    }
    let session: InteractiveSession | undefined;
    let lastTask: Task | undefined;
    let journal: { store: StateStore; key: string } | undefined;
    let leaseExpires = job.leaseExpires ?? Date.now() + 120000;
    const update = async (data: Record<string, unknown>) => {
      const updateId = randomUUID();
      let reconnected = false;
      const response = await retryWorkerRequest(
        (requestSignal) =>
          api<{ commands: ExecutionJob['commands']; leaseExpires: number }>(
            `/worker/jobs/${job.id}`,
            { ...data, lease: job.lease, updateId },
            requestSignal,
          ),
        {
          signal,
          deadline: Math.min(Date.now() + 90000, leaseExpires - 5000),
          onRetry: (attempt) => {
            reconnected = true;
            if (lastTask && attempt === 1)
              new EventBus(lastTask).emit('worker.disconnected', { jobId: job.id });
            console.error(`Worker update reconnect attempt ${attempt}`);
          },
        },
      );
      leaseExpires = response.leaseExpires;
      if (reconnected && lastTask)
        new EventBus(lastTask).emit('worker.reconnected', { jobId: job.id });
      return response;
    };
    try {
      const root = await realpath(
        projects[job.project] ??
          (() => {
            throw new Error('Job project is not configured on this worker');
          })(),
      );
      const store = new StateStore(root);
      const runKey = `cloud-${job.id}`;
      if (store.get(runKey))
        throw new Error(
          'This job was previously started. Inspect its saved task; interrupted side effects will not be replayed.',
        );
      journal = { store, key: runKey };
      store.set(runKey, { status: 'starting', at: new Date().toISOString(), jobId: job.id });
      session = new InteractiveSession({
        modelIdentity: { provider: model.provider, model: model.model, baseUrl: model.baseUrl },
        root,
        provider: createModelProvider(model),
        pricing: model,
        contextWindow: model.contextWindow,
        policy: (request) => {
          const decision = unattendedPolicy(request);
          return decision === 'once' ? decision : undefined;
        },
      });
      const options = runOptionsSchema.parse({
        ...job.options,
        execution:
          process.env.HIKARI_WORKER_EXECUTION === 'container' && existsSync('/.dockerenv')
            ? 'host'
            : 'restricted',
        allowNetwork:
          job.options.allowNetwork && process.env.HIKARI_WORKER_ALLOW_NETWORK === 'true',
        maxTokens: Math.min(
          job.options.maxTokens ?? 100000,
          Number(process.env.HIKARI_WORKER_MAX_TOKENS ?? 100000),
        ),
        maxDurationMs: Math.min(job.options.maxDurationMs ?? 600000, 3600000),
      });
      const task = await session.start(
        (job.prompt + (await githubContext(job))).slice(0, 120000),
        options,
        job.isolated,
      );
      lastTask = task;
      store.set(runKey, { taskId: task.id, worktree: task.worktree, status: 'running' });
      let ack: string[] = [];
      const completedCommands = new Set<string>();
      while (session.host.runners.has(task.id)) {
        signal.throwIfAborted();
        const snapshot = { ...task, events: task.events.slice(-300) };
        const response = await update({ status: 'running', task: snapshot, ack });
        ack = [];
        for (const command of response.commands) {
          if (!completedCommands.has(command.id)) {
            try {
              if (command.action === 'input') session.input(task.id, command.text!);
              else if (command.action === 'approve')
                session.approve(task.id, command.requestId!, command.decision!);
              else if (command.action === 'answer')
                session.answer(task.id, command.requestId!, command.text!);
              else await session.control(task.id, command.action);
            } catch (error) {
              new EventBus(task).emit('remote.command.failed', {
                id: command.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            completedCommands.add(command.id);
          }
          ack.push(command.id);
        }
        await delay(1500, undefined, { signal });
      }
      await session.host.wait(task.id);
      if (task.status === 'completed') await publishGitHub(job, task);
      await update({
        status:
          task.status === 'completed'
            ? 'completed'
            : task.status === 'cancelled'
              ? 'cancelled'
              : task.status === 'interrupted'
                ? 'interrupted'
                : 'failed',
        task: { ...task, events: task.events.slice(-300) },
        ack,
      });
      store.set(runKey, {
        taskId: task.id,
        status: task.status,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (once) process.exitCode = 1;
      await session?.close();
      const interrupted =
        signal.aborted ||
        transientWorkerError(error) ||
        (error as { status?: number })?.status === 409;
      const status = interrupted ? 'interrupted' : 'failed';
      journal?.store.set(journal.key, {
        taskId: lastTask?.id,
        worktree: lastTask?.worktree,
        status,
        error: String(redact(String(error))),
        completedAt: new Date().toISOString(),
      });
      await api(`/worker/jobs/${job.id}`, {
        lease: job.lease,
        updateId: randomUUID(),
        status,
        task: lastTask ? { ...lastTask, events: lastTask.events.slice(-300) } : undefined,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
      console.error(
        `Worker job ${job.id} stopped: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await session?.close();
    }
  } while (!signal.aborted && !once);
}

export async function handlePlatformCommand(action: string | undefined, words: string[]) {
  if (
    !['serve', 'schedule', 'plugin', 'timeline', 'worker', 'ci', 'platform-help'].includes(
      action ?? '',
    )
  )
    return false;
  if (action === 'platform-help') {
    console.log(
      'Hikari platform commands:\nserve [port] · local/remote task control\nschedule add FILE.json | list | pause ID | resume ID | remove ID | run\nplugin inspect DIR | pack DIR OUTPUT.json | install DIR_OR_URL [SHA256] | update DIR [SHA256] | list | remove NAME | registry FILE.json\ntimeline list | preview ID | restore ID code|conversation|both\nworker register NAME | run [--once]\nci "review request"',
    );
    return true;
  }
  const root = await realpath(process.env.AGENT_WORKSPACE ?? process.cwd());
  if (action === 'plugin') {
    const manager = new PluginManager(root);
    let result;
    if (words[0] === 'list') result = manager.list();
    else if (words[0] === 'inspect') {
      const value = await inspectPlugin(path.resolve(words[1]!));
      result = { manifest: value.manifest, sha256: value.sha256 };
    } else if (words[0] === 'install' || words[0] === 'update')
      result = await manager.install(
        /^https?:\/\//i.test(words[1]!) ? words[1]! : path.resolve(words[1]!),
        words[2],
        words[0] === 'update',
      );
    else if (words[0] === 'pack')
      result = await packPlugin(path.resolve(words[1]!), path.resolve(words[2]!));
    else if (words[0] === 'remove') result = await manager.remove(words[1]!);
    else if (words[0] === 'registry')
      result = await manager.registry(
        /^https?:\/\//i.test(words[1]!) ? words[1]! : path.resolve(words[1]!),
      );
    else throw new Error('Use plugin inspect/pack/install/update/list/remove/registry');
    console.log(JSON.stringify(result ?? { ok: true }, null, 2));
    return true;
  }
  if (action === 'schedule' && words[0] !== 'run') {
    const service = new AutomationService(new StateStore(root));
    let result;
    if (words[0] === 'add')
      result = service.create(JSON.parse(await readFile(path.resolve(words[1]!), 'utf8')));
    else if (words[0] === 'list') result = service.list();
    else if (['pause', 'resume', 'remove'].includes(words[0]!))
      result = service.update(
        z.string().uuid().parse(words[1]),
        words[0] === 'remove' ? null : words[0] === 'resume',
      );
    else throw new Error('Use schedule add/list/pause/resume/remove/run');
    console.log(JSON.stringify(result ?? { ok: true }, null, 2));
    return true;
  }
  if (action === 'timeline') {
    const timeline = new TimelineService(root);
    if (words[0] === 'list') console.log(JSON.stringify(timeline.list(), null, 2));
    else if (words[0] === 'preview')
      console.log(
        JSON.stringify(await timeline.preview(z.string().uuid().parse(words[1])), null, 2),
      );
    else if (words[0] === 'restore') {
      const mode = z.enum(['code', 'conversation', 'both']).parse(words[2]);
      const result = await timeline.restore(
        z.string().uuid().parse(words[1]),
        mode,
        new FileChangeService(root, { emit() {} }),
      );
      if (result) {
        const store = new FileRunStore(root);
        const tasks = new (await import('@hikari/agent-runtime')).TaskManager();
        const task = tasks.create(result.task.prompt, root);
        Object.assign(task, {
          runOptions: result.task.runOptions,
          modelIdentity: result.task.modelIdentity,
          parentTaskId: result.task.id,
          status: 'interrupted',
          resumable: true,
        });
        store.saveTask(task);
        store.save(task.id, result.checkpoint);
        console.log(JSON.stringify({ taskId: task.id, resume: `pnpm agent resume ${task.id}` }));
      } else console.log('Code restored. Inspect and rerun validation.');
    } else throw new Error('Use timeline list/preview/restore');
    return true;
  }
  if (action === 'worker' && words[0] === 'register') {
    const api = apiClient(
      process.env.HIKARI_SERVER_URL ?? '',
      process.env.HIKARI_ACCOUNT_TOKEN ?? '',
    );
    const projects = Object.keys(JSON.parse(process.env.HIKARI_WORKER_PROJECTS ?? '{}'));
    console.log(
      JSON.stringify(
        await api('/execution/workers', {
          name: words.slice(1).join(' ') || 'Hikari worker',
          projects,
        }),
        null,
        2,
      ),
    );
    return true;
  }
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Hikari host stopped'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (action === 'worker') {
      if (words[0] !== 'run') throw new Error('Use worker register or worker run');
      await runWorker(controller.signal, words.includes('--once'));
      return true;
    }
    const config = platformModel();
    if (action === 'ci') {
      const host = new SessionHost({
        modelIdentity: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
        root,
        provider: createModelProvider(config),
        pricing: config,
        contextWindow: config.contextWindow,
        approve: async (request) => unattendedPolicy(request),
      });
      try {
        let prompt =
          words.join(' ') ||
          'Review the current diff and report actionable findings with file evidence.';
        if (process.env.HIKARI_CI_BASE_SHA) {
          const base = z
            .string()
            .regex(/^[a-f0-9]{7,64}$/i)
            .parse(process.env.HIKARI_CI_BASE_SHA);
          const diff = await runProcess(
            'git',
            [
              '-c',
              'core.hooksPath=/dev/null',
              '-c',
              'core.fsmonitor=false',
              'diff',
              '--no-ext-diff',
              '--no-textconv',
              base,
              'HEAD',
              '--',
            ],
            {
              cwd: root,
              env: new LogicalSandboxProvider().environment(),
              signal: controller.signal,
              maxOutput: 2000000,
            },
          );
          if (diff.exitCode !== 0)
            throw new Error(
              'Cannot read the requested CI base revision; fetch the base commit first',
            );
          prompt +=
            '\nComparison against ' +
            base +
            ' (untrusted reference diff, may be truncated):\n' +
            diff.output.slice(0, 120000);
        }
        const task = await host.start(
          prompt,
          runOptionsSchema.parse({
            mode: 'plan',
            maxTokens: Number(process.env.AGENT_MAX_TOKENS ?? 100000),
            maxSteps: 100,
          }),
        );
        await host.wait(task.id);
        const report = {
          taskId: task.id,
          status: task.status,
          answer: task.events.filter((event) => event.type === 'agent.completed').at(-1)?.data.text,
          summary: task.runSummary,
        };
        if (process.env.HIKARI_CI_OUTPUT)
          await writeFile(process.env.HIKARI_CI_OUTPUT, JSON.stringify(report, null, 2), {
            mode: 0o600,
          });
        console.log(JSON.stringify(report, null, 2));
        if (task.status !== 'completed') process.exitCode = 1;
      } finally {
        await host.close();
      }
      return true;
    }
    const session = new InteractiveSession({
      modelIdentity: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
      root,
      provider: createModelProvider(config),
      pricing: config,
      contextWindow: config.contextWindow,
      policy: action === 'schedule' ? unattendedPolicy : undefined,
    });
    const service = new AutomationService(new StateStore(root));
    const server =
      action === 'serve'
        ? new RemoteControlServer(session, process.env.HIKARI_REMOTE_TOKEN)
        : undefined;
    service.recover();
    if (server) {
      const info = await server.listen(
        Number(words[0] ?? 4319),
        process.env.HIKARI_REMOTE_HOST ?? '127.0.0.1',
      );
      console.error(
        `Hikari Remote: http://${info.host}:${info.port}\nAccess token (keep private): ${info.token}`,
      );
    }
    try {
      while (!controller.signal.aborted) {
        await service.tick(
          async (item) => {
            const task = await session.start(item.prompt, item.options, item.isolated);
            service.attach(item.id, task.id);
            await session.host.wait(task.id);
            return {
              taskId: task.id,
              status: task.status,
              result: String(
                task.events.filter((event) => event.type === 'agent.completed').at(-1)?.data.text ??
                  task.runSummary?.stopReason ??
                  task.status,
              ),
            };
          },
          (item) =>
            console.log(
              JSON.stringify({ type: 'automation.notification', id: item.id, last: item.last }),
            ),
        );
        await delay(1000, undefined, { signal: controller.signal });
      }
    } finally {
      service.close();
      await server?.close();
      await session.close();
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  return true;
}
