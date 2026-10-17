import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AgentError,
  hookSchema,
  redact,
  type PermissionManager,
  type Task,
  type EventSink,
} from '@hikari/agent-core';
import type { Lifecycle, LifecycleEvent } from '@hikari/agent-runtime';
import { LogicalSandboxProvider, runProcess, type SandboxProvider } from '@hikari/sandbox';
import type { FileChangeService } from './patch';
import { installedManifests, expandPlugin } from './plugins';

export class HookLifecycle implements Lifecycle {
  private hooks: z.output<typeof hookSchema>[] = [];
  constructor(
    private task: Task,
    private events: EventSink,
    private permissions: PermissionManager,
    private sandbox: SandboxProvider,
    private changes: FileChangeService,
  ) {}
  async load(root: string) {
    const filename = await new LogicalSandboxProvider().resolve(root, '.agent/hooks.json');
    const text = await readFile(filename, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '[]';
      throw error;
    });
    if (text.length > 128000) throw new Error('Hooks configuration exceeds 128 KB');
    this.hooks = z.array(hookSchema).max(50).parse(JSON.parse(text));
    for (const { manifest, directory } of await installedManifests(root))
      this.hooks.push(
        ...manifest.hooks.map((hook) => ({
          ...hook,
          id: `${manifest.name}-${hook.id}`,
          command: expandPlugin(hook.command, directory),
          args: hook.args.map((arg) => expandPlugin(arg, directory)),
        })),
      );
    if (new Set(this.hooks.map((hook) => hook.id)).size !== this.hooks.length)
      throw new Error('Hook IDs must be unique');
    return this;
  }
  async dispatch(
    event: LifecycleEvent,
    signal: AbortSignal,
    call?: import('@hikari/agent-core').ToolCall,
    result?: import('@hikari/agent-core').ToolResult,
  ) {
    for (const hook of this.hooks.filter(
      (hook) => hook.event === event && (!hook.tool || hook.tool === call?.name),
    )) {
      signal.throwIfAborted();
      this.sandbox.validateCommand(hook.command, hook.args);
      const allowed = await this.permissions.check(
        {
          id: randomUUID(),
          taskId: this.task.id,
          tool: `hook:${hook.id}`,
          permission: 'shell.execute',
          workspace: this.changes.root,
          input: { event, command: hook.command, args: hook.args },
        },
        signal,
      );
      if (!allowed) throw new AgentError('HOOK_DENIED', `Hook denied: ${hook.id}`);
      const before = await this.changes.snapshotExternal(signal);
      const launch = await this.sandbox.launch?.(hook.command, hook.args, this.changes.root);
      let output;
      try {
        output = await runProcess(launch?.command ?? hook.command, launch?.args ?? hook.args, {
          cwd: this.changes.root,
          env: launch?.env ?? this.sandbox.environment(),
          signal,
          timeoutMs: hook.timeoutMs,
          maxOutput: 32000,
          stdin: JSON.stringify(
            redact({
              event,
              taskId: this.task.id,
              call,
              result: result
                ? { content: result.content.slice(0, 8000), error: result.error }
                : undefined,
            }),
          ),
        });
      } finally {
        await launch?.cleanup();
        await this.changes.recordExternal(before);
      }
      this.events.emit('hook.completed', { id: hook.id, event, ...output });
      if (output.exitCode !== 0)
        throw new AgentError(
          'HOOK_BLOCKED',
          `Hook ${hook.id} blocked ${event}: ${output.output.slice(0, 4000)}`,
        );
    }
  }
}
