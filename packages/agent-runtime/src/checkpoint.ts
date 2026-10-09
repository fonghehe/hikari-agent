import { workflowSchema, type WorkflowState } from './workflow';
import { z } from 'zod';
import { runSummarySchema } from '@hikari/agent-core';
import type { Message, ModelUsage, RunSummary, ToolCall } from '@hikari/agent-core';
export interface RunnerCheckpoint {
  version: 1;
  messages: Message[];
  memory: [string, string][];
  summary: RunSummary;
  revision: number;
  testedRevision: Record<string, number>;
  pending: { call: ToolCall; state: 'ready' | 'running' | 'done' }[];
  queued: string[];
  restrictions?: string[];
  answeredQuestion?: { id: string; answer: string; toolCallId?: string };
  needsVerification?: boolean;
  workflow?: WorkflowState;
  updatedAt: string;
  done: boolean;
}
export interface CheckpointStore {
  load(id: string): RunnerCheckpoint | undefined;
  save(id: string, checkpoint: RunnerCheckpoint): void;
}
export interface UsagePricing {
  inputPerMillion?: number;
  outputPerMillion?: number;
  maxOutputTokens?: number;
}
export function usageCost(usage: ModelUsage, pricing?: UsagePricing) {
  if (pricing?.inputPerMillion === undefined || pricing.outputPerMillion === undefined)
    return undefined;
  return (
    (usage.inputTokens * pricing.inputPerMillion + usage.outputTokens * pricing.outputPerMillion) /
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
      }),
    )
    .max(20),
  queued: z.array(z.string().max(12000)).max(20),
  restrictions: z.array(z.string()).optional(),
  answeredQuestion: z
    .object({ id: z.string(), answer: z.string().max(12000), toolCallId: z.string().optional() })
    .optional(),
  needsVerification: z.boolean().optional(),
  workflow: workflowSchema.optional(),
  updatedAt: z.string(),
  done: z.boolean(),
});
export function parseCheckpoint(value: unknown): RunnerCheckpoint | undefined {
  const result = checkpointSchema.safeParse(value);
  return result.success ? (result.data as RunnerCheckpoint) : undefined;
}
export function testKey(command: string, cwd: string) {
  return JSON.stringify([cwd, command]);
}
