import {
  AgentError,
  errorMessage,
  type PermissionManager,
  type ToolCall,
  type ToolContext,
  type ToolResult,
} from '@hikari/agent-core';
import type { ToolRegistry } from '../tool-registry';

export interface ReadOutcome {
  call: ToolCall;
  input?: unknown;
  result: ToolResult;
  durationMs: number;
}
function failed(error: unknown): ToolResult {
  return {
    content: errorMessage(error),
    error: true,
    metadata: {
      errorCode: error instanceof AgentError ? error.code : (error as NodeJS.ErrnoException)?.code,
    },
  };
}

/** Permissions are admitted serially; only approved, explicit reads overlap. */
export async function executeReadBatch(
  calls: ToolCall[],
  options: {
    tools: ToolRegistry;
    permissions: PermissionManager;
    context: ToolContext;
    checkpoint(): Promise<void>;
    requested(call: ToolCall): void;
    admitted(calls: { call: ToolCall; input: unknown }[]): void;
  },
) {
  const prepared: { call: ToolCall; input?: unknown; rejection?: ToolResult }[] = [];
  for (const call of calls) {
    options.context.signal.throwIfAborted();
    options.requested(call);
    try {
      const tool = options.tools.get(call.name);
      const input = tool.parse(call.input);
      if (!tool.parallelSafe || tool.permissionFor(input) !== 'filesystem.read')
        throw new AgentError(
          'PARALLEL_READ_DENIED',
          'Only explicitly safe filesystem reads can overlap',
        );
      const allowed = await options.permissions.check(
        {
          id: call.id,
          taskId: options.context.taskId,
          tool: call.name,
          input,
          permission: 'filesystem.read',
          workspace: options.context.workspace,
        },
        options.context.signal,
      );
      if (!allowed) throw new AgentError('PERMISSION_DENIED', `Permission denied: ${call.name}`);
      prepared.push({ call, input });
    } catch (error) {
      prepared.push({ call, rejection: failed(error) });
    }
  }
  await options.checkpoint();
  // This callback durably records all running operations before starting any of them.
  options.admitted(
    prepared.filter((entry) => !entry.rejection).map(({ call, input }) => ({ call, input })),
  );
  return Promise.all(
    prepared.map(async ({ call, input, rejection }): Promise<ReadOutcome> => {
      const start = Date.now();
      if (rejection) return { call, input, result: rejection, durationMs: 0 };
      let result: ToolResult;
      try {
        options.context.signal.throwIfAborted();
        result = await options.tools.get(call.name).execute(input, options.context);
      } catch (error) {
        result = failed(error);
      }
      return { call, input, result, durationMs: Date.now() - start };
    }),
  );
}
