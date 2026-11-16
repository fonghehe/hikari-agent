import { workflowSchema, type WorkflowState } from '../orchestration/development-workflow';
import { z } from 'zod';
import { runSummarySchema } from '@hikari/agent-core';
import type { Message, ModelUsage, RunSummary, ToolCall } from '@hikari/agent-core';
import type { ToolOutputStore } from '../context/observations';
import type { RequestTraceStore } from './request-trace';
import { operationSchema, type OperationRecord } from '../runner/operations';
import type { MetricsState } from '../runner/metrics';
export interface RunnerCheckpoint {
  version: 1;
  messages: Message[];
  memory: [string, string][];
  summary: RunSummary;
  revision: number;
  testedRevision: Record<string, number>;
  pending: { call: ToolCall; state: 'ready' | 'running' | 'done'; operationId?: string }[];
  operations?: OperationRecord[];
  metrics?: MetricsState;
  queued: string[];
  runtimeChecks?: boolean;
  pendingLifecycle?: { event: import('../runner/lifecycle').LifecycleEvent; callId?: string };
  sessionStarted?: boolean;
  restrictions?: string[];
  answeredQuestion?: { id: string; answer: string; toolCallId?: string };
  needsVerification?: boolean;
  workflow?: WorkflowState;
  updatedAt: string;
  done: boolean;
  goal?: import('@hikari/agent-core').Task['goal'];
}
export interface CheckpointStore extends Partial<ToolOutputStore>, Partial<RequestTraceStore> {
  load(id: string): RunnerCheckpoint | undefined;
  save(id: string, checkpoint: RunnerCheckpoint): void;
}
export interface UsagePricing {
  inputPerMillion?: number;
  outputPerMillion?: number;
  maxOutputTokens?: number;
  cachedInputPerMillion?: number;
  cacheWriteInputPerMillion?: number;
}
export function usageCost(usage: ModelUsage, pricing?: UsagePricing) {
  if (pricing?.inputPerMillion === undefined || pricing.outputPerMillion === undefined)
    return undefined;
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens ?? 0);
  const written = Math.min(
    Math.max(0, usage.inputTokens - cached),
    usage.cacheWriteInputTokens ?? 0,
  );
  return (
    ((usage.inputTokens - cached - written) * pricing.inputPerMillion +
      cached * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion) +
      written * (pricing.cacheWriteInputPerMillion ?? pricing.inputPerMillion) +
      usage.outputTokens * pricing.outputPerMillion) /
    1000000
  );
}

const checkpointSchema = z.object({
  version: z.literal(1),
  messages: z
    .array(
      z
        .object({
          role: z.enum(['system', 'user', 'assistant', 'tool']),
          content: z.string(),
          toolCalls: z
            .array(z.object({ id: z.string(), name: z.string(), input: z.unknown() }))
            .optional(),
          toolCallId: z.string().optional(),
          images: z
            .array(z.object({ mimeType: z.enum(['image/png', 'image/jpeg']), data: z.string() }))
            .optional(),
        })
        .passthrough(),
    )
    .max(10000),
  memory: z.array(z.tuple([z.string(), z.string()])).max(1000),
  summary: runSummarySchema,
  revision: z.number().int().nonnegative(),
  testedRevision: z.record(z.number().int().nonnegative()),
  pending: z
    .array(
      z.object({
        call: z.object({ id: z.string(), name: z.string(), input: z.unknown() }),
        state: z.enum(['ready', 'running', 'done']),
        operationId: z.string().optional(),
      }),
    )
    .max(20),
  queued: z.array(z.string().max(12000)).max(20),
  operations: z.array(operationSchema).max(2000).optional(),
  metrics: z
    .object({ questions: z.array(z.string()).max(2000), approvals: z.array(z.string()).max(2000) })
    .optional(),
  runtimeChecks: z.boolean().optional(),
  pendingLifecycle: z
    .object({
      event: z.enum(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']),
      callId: z.string().optional(),
    })
    .optional(),
  sessionStarted: z.boolean().optional(),
  restrictions: z.array(z.string()).optional(),
  answeredQuestion: z
    .object({ id: z.string(), answer: z.string().max(12000), toolCallId: z.string().optional() })
    .optional(),
  needsVerification: z.boolean().optional(),
  workflow: workflowSchema.optional(),
  updatedAt: z.string(),
  done: z.boolean(),
  goal: z
    .object({
      objective: z.string(),
      status: z.enum(['active', 'complete', 'paused', 'blocked']),
      continuations: z.number().int().nonnegative(),
      evidence: z.string().optional(),
    })
    .optional(),
});
export function parseCheckpoint(value: unknown): RunnerCheckpoint | undefined {
  const result = checkpointSchema.safeParse(value);
  return result.success ? (result.data as RunnerCheckpoint) : undefined;
}
export function testKey(command: string, cwd: string) {
  return JSON.stringify([cwd, command]);
}
