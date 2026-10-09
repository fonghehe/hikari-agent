import type { RunOptions, TaskPlan, RunSummary } from './task-controls';
export * from './task-controls';
import type { ZodType, ZodTypeDef } from 'zod';
export const states = [
  'idle',
  'planning',
  'thinking',
  'executing_tool',
  'waiting_permission',
  'waiting_input',
  'interrupted',
  'observing',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type AgentState = (typeof states)[number];
export type Permission =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'filesystem.delete'
  | 'shell.execute'
  | 'shell.network'
  | 'shell.system'
  | 'git.write'
  | 'browser.access';
export type Decision = 'once' | 'session' | 'always' | 'deny';
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}
export interface ModelImage {
  mimeType: 'image/jpeg' | 'image/png';
  data: string;
}
export interface Attachment {
  id: string;
  name: string;
  kind: 'text' | 'image';
  mimeType: string;
  size: number;
  preview?: string;
  textLength?: number;
  truncated?: boolean;
  pages?: number;
  width?: number;
  height?: number;
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Opaque protocol state, kept in private checkpoints rather than UI events. */
  providerData?: Record<string, unknown>;
  images?: ModelImage[];
  /** Reference data for offline demonstrations; providers encode content/images. */
  references?: {
    name: string;
    kind: 'text' | 'image';
    text?: string;
    width?: number;
    height?: number;
  }[];
}
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  estimated?: boolean;
}
export interface UserQuestion {
  id: string;
  question: string;
  choices?: string[];
}
export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  usage?: ModelUsage;
  providerData?: Record<string, unknown>;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ModelRequest {
  messages: Message[];
  tools: ToolDefinition[];
  signal: AbortSignal;
  maxOutputTokens?: number;
}
export interface ModelProvider {
  chat(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelResponse>;
  countTokens(text: string): number;
}
export interface AgentEvent {
  id: string;
  taskId: string;
  agentId: string;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}
export interface Task {
  id: string;
  title: string;
  prompt: string;
  parentTaskId?: string;
  /** Explicitly simulated: no external model or host tools are used. */
  demo?: boolean;
  /** A model conversation without access to a local project. */
  chat?: boolean;
  attachments?: Attachment[];
  modelProfileId?: string;
  modelIdentity?: { provider: string; model: string; baseUrl?: string };
  archived?: boolean;
  imported?: boolean;
  runOptions?: RunOptions;
  plan?: TaskPlan;
  runSummary?: RunSummary;
  pendingQuestion?: UserQuestion;
  resumable?: boolean;
  status: AgentState;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  worktree?: string;
  worktreeArchive?: string;
  agentId: string;
  events: AgentEvent[];
}
export interface EventSink {
  emit(type: string, data?: Record<string, unknown>): void;
}
export interface ToolContext {
  taskId: string;
  workspace: string;
  signal: AbortSignal;
  events: EventSink;
}
export interface ToolResult {
  image?: ModelImage;
  content: string;
  error?: boolean;
  metadata?: Record<string, unknown>;
}
export interface Tool<T = unknown> {
  name: string;
  description: string;
  schema: ZodType<T, ZodTypeDef, unknown>;
  permission: Permission;
  permissionFor?(input: T): Permission;
  jsonSchema?: Record<string, unknown>;
  execute(input: T, context: ToolContext): Promise<ToolResult>;
}
export interface PermissionRequest {
  id: string;
  taskId: string;
  tool: string;
  permission: Permission;
  input: unknown;
  workspace: string;
}
export interface PermissionManager {
  check(request: PermissionRequest, signal: AbortSignal): Promise<boolean>;
}
export class AgentError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export { searchTerms } from './search';
export function redact(value: unknown): unknown {
  if (typeof value === 'string')
    return value
      .replace(/("(?:api[_-]?key|password|token|secret)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
      .replace(/\b(sk-[\w-]{8,}|Bearer\s+[\w.-]+)/gi, '[REDACTED]')
      .replace(/((?:api[_-]?key|password|token|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /secret|password|api.?key|authorization|^(access_?|refresh_?)?token$/i.test(k)
          ? '[REDACTED]'
          : redact(v),
      ]),
    );
  return value;
}
