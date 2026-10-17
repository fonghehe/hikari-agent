import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { SessionHost } from '../packages/agent-host/src';
import { GitService } from '../packages/git/src';
import {
  runOptionsSchema,
  type ModelProvider,
  type ModelResponse,
} from '../packages/agent-core/src';
import { TimelineService } from '../packages/tools/src';
import { WorkspaceOwnership } from '../packages/agent-runtime/src';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function project() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-host-')));
  roots.push(root);
  await writeFile(path.join(root, 'file.txt'), 'before');
  await writeFile(path.join(root, '.gitignore'), '.agent/\n');
  const git = new GitService(root);
  await git.run(['init', '--quiet']);
  await git.run(['add', 'file.txt', '.gitignore']);
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
  return root;
}
it('delegates writable work into a worktree, validates it and charges it to the parent', async () => {
  const root = await project();
  let parentStep = 0,
    childStep = 0;
  const call = (name: string, input: unknown): ModelResponse => ({
    text: '',
    toolCalls: [{ id: `${name}-${parentStep}-${childStep}`, name, input }],
    usage: { inputTokens: 100, outputTokens: 10 },
  });
  const provider: ModelProvider = {
    countTokens: () => 1,
    async chat(request) {
      if (request.messages[0]?.content.includes('delegated Hikari worker')) {
        const child = host.tasks.list().find((item) => item.delegated)!;
        expect(WorkspaceOwnership.current(child.worktree!)?.taskId).toBe(child.id);
        const step = childStep++;
        if (step === 0) return call('read_file', { path: 'file.txt' });
        if (step === 1)
          return call('write_file', {
            path: 'file.txt',
            content: 'after',
            expectedHash: createHash('sha256').update('before').digest('hex'),
          });
        if (step === 2)
          return call('run_tests', {
            command: process.execPath,
            args: [
              '-e',
              "if(require('fs').readFileSync('file.txt','utf8')!=='after') process.exit(1)",
            ],
          });
        return {
          text: 'Changed file.txt and verified it in the isolated worktree.',
          toolCalls: [],
          usage: { inputTokens: 100, outputTokens: 10 },
        };
      }
      const step = parentStep++;
      if (step === 0)
        return call('spawn_agent', {
          prompt: 'Update file.txt to after and test it. Preserve other files.',
          writable: true,
          maxTokens: 40000,
        });
      if (step === 1) {
        const observation = request.messages.filter((message) => message.role === 'tool').at(-1)!;
        return call('wait_agent', { id: JSON.parse(observation.content).id });
      }
      return {
        text: 'Delegated changes are ready for review; the original file remains intact.',
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 10 },
      };
    },
    async *stream(request) {
      yield await this.chat(request);
    },
  };
  const host = new SessionHost({ root, provider, approve: async () => 'once' });
  try {
    const task = await host.start(
      'Delegate an isolated change',
      runOptionsSchema.parse({ execution: 'host', maxTokens: 100000 }),
    );
    await host.wait(task.id);
    expect(task.status).toBe('completed');
    const spawned = task.events.find((event) => event.type === 'subagent.spawned')!;
    const child = host.tasks.get(String(spawned.data.id));
    expect(child.status).toBe('completed');
    expect(WorkspaceOwnership.current(child.worktree!)).toBeUndefined();
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('before');
    expect(await readFile(path.join(child.worktree!, 'file.txt'), 'utf8')).toBe('after');
    expect(child.runSummary?.tests[0]?.status).toBe('passed');
    expect(task.runSummary?.inputTokens).toBe(700);
    expect(task.runSummary?.costUsd).toBeUndefined();
    expect(new TimelineService(root).list(task.id).map((entry) => entry.label)).toEqual([
      'before',
      'after',
    ]);
  } finally {
    await host.close();
  }
});
