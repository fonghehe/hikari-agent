import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  sanitizeMessage,
  redact,
  type Message,
  type ToolDefinition,
  type Task,
} from '@hikari/agent-core';

export interface ContextBuildInfo {
  sourceMessages: number;
  admittedMessages: number;
  truncatedResults: number;
  summarizedExchanges: number;
  removedTurns: number;
  omittedImages: number;
}
/** Private provider-neutral input, not a provider wire-format transcript. */
export interface ModelRequestTrace {
  version: 1;
  id: string;
  step: number;
  createdAt: string;
  model?: Task['modelIdentity'];
  messages: Message[];
  tools: ToolDefinition[];
  inputBudget: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  compaction: ContextBuildInfo;
  contentHash?: string;
  omitted?: 'size-limit';
}
export interface RequestTraceStore {
  saveRequest(taskId: string, trace: ModelRequestTrace): void;
  requests(taskId: string): ModelRequestTrace[];
}
const traceSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    step: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    messages: z.array(
      z
        .object({
          role: z.enum(['system', 'user', 'assistant', 'tool']),
          content: z.string(),
        })
        .passthrough(),
    ),
    tools: z.array(
      z.object({ name: z.string(), description: z.string(), parameters: z.record(z.unknown()) }),
    ),
    inputBudget: z.number().nonnegative(),
    estimatedInputTokens: z.number().nonnegative(),
    maxOutputTokens: z.number().nonnegative(),
    compaction: z.object({
      sourceMessages: z.number(),
      admittedMessages: z.number(),
      truncatedResults: z.number(),
      summarizedExchanges: z.number(),
      removedTurns: z.number(),
      omittedImages: z.number(),
    }),
  })
  .passthrough();
export function parseRequestTraces(value: unknown): ModelRequestTrace[] {
  return z
    .array(traceSchema)
    .max(16)
    .parse(value ?? []) as ModelRequestTrace[];
}
const maximumBytes = 8000000;
export function appendRequestTrace(previous: ModelRequestTrace[], trace: ModelRequestTrace) {
  const record: ModelRequestTrace = {
    ...trace,
    messages: trace.messages.map((message) => sanitizeMessage(structuredClone(message))),
    tools: redact(structuredClone(trace.tools)) as ToolDefinition[],
    model: trace.model
      ? (redact(structuredClone(trace.model)) as Task['modelIdentity'])
      : undefined,
  };
  const encoded = JSON.stringify(record);
  record.contentHash = createHash('sha256').update(encoded).digest('hex');
  // Oversized inputs retain honest metadata instead of failing an otherwise valid task.
  let recordBytes = Buffer.byteLength(JSON.stringify(record));
  if (recordBytes > maximumBytes) {
    record.messages = [];
    record.tools = [];
    record.omitted = 'size-limit';
    recordBytes = Buffer.byteLength(JSON.stringify(record));
  }
  const records = [...previous.filter((item) => item.id !== record.id), record].slice(-16);
  // Reuse per-append sizes only: caller-owned records may change between appends.
  const sizes = records.map((item) =>
    item === record ? recordBytes : Buffer.byteLength(JSON.stringify(item)),
  );
  let bytes = sizes.reduce((sum, size) => sum + size + 1, 2);
  let removed = 0;
  while (bytes > maximumBytes && records.length - removed > 1) bytes -= sizes[removed++]! + 1;
  if (removed) records.splice(0, removed);
  return records;
}
