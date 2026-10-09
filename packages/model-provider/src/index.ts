export * from './factory';
import { providerFetch } from './http';
import type { ModelUsage } from '@hikari/agent-core';
import { sse } from './sse';
export { DemoProvider, demoWorkspace, demoFiles, demoTools } from './demo';
import { z } from 'zod';
import {
  AgentError,
  type Message,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '@hikari/agent-core';
export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  tokenParameter?: 'max_tokens' | 'max_completion_tokens';
  includeUsage?: boolean;
  authType?: 'bearer' | 'api-key';
  reasoningEffort?: 'low' | 'medium' | 'high';
  inlineReasoning?: boolean;
}
const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
});
const replySchema = z.object({
  usage: usageSchema.nullable().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          content: z.string().nullable().optional(),
          reasoning_content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .min(1),
});
const encode = (m: Message) => ({
  role: m.role,
  ...(m.role === 'assistant' && typeof m.providerData?.reasoningContent === 'string'
    ? { reasoning_content: m.providerData.reasoningContent }
    : {}),
  content: m.images?.length
    ? [
        { type: 'text', text: m.content },
        ...m.images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mimeType};base64,${image.data}` },
        })),
      ]
    : m.role === 'assistant' && typeof m.providerData?.rawAssistantContent === 'string'
      ? m.providerData.rawAssistantContent
      : m.content,
  ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
  ...(m.toolCalls?.length
    ? {
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input) },
        })),
      }
    : {}),
});
export class OpenAICompatibleProvider implements ModelProvider {
  private visible(text: string) {
    if (!this.config.inlineReasoning) return text;
    return text
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*$/, '')
      .replace(/<t(?:h(?:i(?:n(?:k)?)?)?)?$/, '')
      .trimStart();
  }
  private protocolData(text: string, reasoning?: string | null) {
    return reasoning || this.config.inlineReasoning
      ? {
          ...(reasoning ? { reasoningContent: reasoning } : {}),
          ...(this.config.inlineReasoning ? { rawAssistantContent: text } : {}),
        }
      : undefined;
  }
  constructor(protected config: ProviderConfig) {
    const url = new URL(config.baseUrl ?? 'https://api.openai.com/v1');
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new AgentError('INVALID_ENDPOINT', 'Use HTTPS or a localhost endpoint');
  }
  countTokens(text: string) {
    return Math.ceil(new TextEncoder().encode(text).length / 3);
  }
  async chat(request: ModelRequest): Promise<ModelResponse> {
    const response = await providerFetch(
      `${(this.config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.authType === 'api-key'
            ? { 'api-key': this.config.apiKey }
            : { Authorization: `Bearer ${this.config.apiKey}` }),
        },
        body: JSON.stringify({
          model: this.config.model,
          ...(this.config.reasoningEffort ? { reasoning_effort: this.config.reasoningEffort } : {}),
          ...(request.maxOutputTokens
            ? { [this.config.tokenParameter ?? 'max_tokens']: request.maxOutputTokens }
            : {}),
          messages: request.messages.map(encode),
          ...(request.tools.length
            ? { tools: request.tools.map((t) => ({ type: 'function', function: t })) }
            : {}),
        }),
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(this.config.timeoutMs ?? 120000),
        ]),
      },
      this.config.retries ?? 3,
    );
    if (!response.ok)
      throw new AgentError('PROVIDER_HTTP', `Model endpoint returned HTTP ${response.status}`);
    const parsed = replySchema.parse(await response.json());
    if (parsed.choices[0]!.finish_reason === 'length')
      throw new AgentError('MODEL_LENGTH', 'Model output limit reached before completion');
    const message = parsed.choices[0]!.message;
    return {
      text: this.visible(message.content ?? ''),
      providerData: this.protocolData(message.content ?? '', message.reasoning_content),
      usage: parsed.usage
        ? { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens }
        : undefined,
      toolCalls: (message.tool_calls ?? []).map((t) => ({
        id: t.id,
        name: t.function.name,
        input: JSON.parse(t.function.arguments) as unknown,
      })),
    };
  }
  async *stream(request: ModelRequest): AsyncIterable<ModelResponse> {
    const response = await providerFetch(
      `${(this.config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.authType === 'api-key'
            ? { 'api-key': this.config.apiKey }
            : { Authorization: `Bearer ${this.config.apiKey}` }),
        },
        body: JSON.stringify({
          model: this.config.model,
          ...(this.config.reasoningEffort ? { reasoning_effort: this.config.reasoningEffort } : {}),
          ...(request.maxOutputTokens
            ? { [this.config.tokenParameter ?? 'max_tokens']: request.maxOutputTokens }
            : {}),
          stream: true,
          ...(this.config.includeUsage !== false
            ? { stream_options: { include_usage: true } }
            : {}),
          messages: request.messages.map(encode),
          ...(request.tools.length
            ? { tools: request.tools.map((tool) => ({ type: 'function', function: tool })) }
            : {}),
        }),
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(this.config.timeoutMs ?? 120000),
        ]),
      },
      this.config.retries ?? 3,
    );
    if (!response.ok)
      throw new AgentError('PROVIDER_HTTP', `Model endpoint returned HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const parsed = replySchema.parse(await response.json());
      if (parsed.choices[0]!.finish_reason === 'length')
        throw new AgentError('MODEL_LENGTH', 'Model output limit reached before completion');
      const message = parsed.choices[0]!.message;
      yield {
        text: this.visible(message.content ?? ''),
        providerData: this.protocolData(message.content ?? '', message.reasoning_content),
        usage: parsed.usage
          ? {
              inputTokens: parsed.usage.prompt_tokens,
              outputTokens: parsed.usage.completion_tokens,
            }
          : undefined,
        toolCalls: (message.tool_calls ?? []).map((tool) => ({
          id: tool.id,
          name: tool.function.name,
          input: JSON.parse(tool.function.arguments) as unknown,
        })),
      };
      return;
    }
    const chunkSchema = z.object({
      usage: usageSchema.nullable().optional(),
      choices: z.array(
        z.object({
          delta: z.object({
            content: z.string().nullable().optional(),
            reasoning_content: z.string().nullable().optional(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number(),
                  id: z.string().optional(),
                  function: z
                    .object({ name: z.string().optional(), arguments: z.string().optional() })
                    .optional(),
                }),
              )
              .optional(),
          }),
          finish_reason: z.string().nullable().optional(),
        }),
      ),
    });
    let text = '';
    let reasoning = '';
    let usage: ModelUsage | undefined;
    let finished = false;
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const raw of sse(response)) {
      const chunk = chunkSchema.parse(raw);
      if (chunk.usage)
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        };
      const choice = chunk.choices[0];
      if (!choice) {
        if (usage) yield { text: this.visible(text), toolCalls: [], usage };
        continue;
      }
      if (choice.finish_reason === 'length')
        throw new AgentError('MODEL_LENGTH', 'Model output limit reached before completion');
      if (choice.finish_reason) finished = true;
      text += choice.delta.content ?? '';
      reasoning += choice.delta.reasoning_content ?? '';
      for (const part of choice.delta.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
        call.id += part.id ?? '';
        call.name += part.function?.name ?? '';
        call.arguments += part.function?.arguments ?? '';
        calls.set(part.index, call);
      }
      yield { text: this.visible(text), toolCalls: [], usage };
    }
    if (!finished)
      throw new AgentError('TRUNCATED_STREAM', 'Model stream ended without a completion marker');
    yield {
      text: this.visible(text),
      usage,
      providerData: this.protocolData(text, reasoning),
      toolCalls: [...calls.values()].map((call) => ({
        id: z.string().min(1).parse(call.id),
        name: z.string().min(1).parse(call.name),
        input: JSON.parse(call.arguments) as unknown,
      })),
    };
  }
}
export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super({ tokenParameter: 'max_completion_tokens', ...config });
  }
}
const anthropicUsage = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
});
const anthropicSchema = z.object({
  usage: anthropicUsage.optional(),
  content: z.array(
    z.union([
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({
        type: z.literal('tool_use'),
        id: z.string(),
        name: z.string(),
        input: z.unknown(),
      }),
    ]),
  ),
});
export class AnthropicProvider extends OpenAICompatibleProvider {
  private async request(request: ModelRequest, stream = false): Promise<Response> {
    const messages: { role: string; content: unknown[] }[] = [];
    for (const m of request.messages.filter((m) => m.role !== 'system')) {
      const role = m.role === 'tool' ? 'user' : m.role;
      const content: unknown[] =
        m.role === 'tool'
          ? [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
          : [
              ...(m.content ? [{ type: 'text', text: m.content }] : []),
              ...(m.images ?? []).map((image) => ({
                type: 'image',
                source: { type: 'base64', media_type: image.mimeType, data: image.data },
              })),
              ...(m.toolCalls ?? []).map((t) => ({
                type: 'tool_use',
                id: t.id,
                name: t.name,
                input: t.input,
              })),
            ];
      const previous = messages.at(-1);
      if (previous?.role === role) previous.content.push(...content);
      else messages.push({ role, content });
    }
    const response = await providerFetch(
      `${(this.config.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '')}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: request.maxOutputTokens ?? 4096,
          stream,
          system: request.messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n'),
          messages,
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          })),
        }),
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(this.config.timeoutMs ?? 120000),
        ]),
      },
      this.config.retries ?? 3,
    );
    if (!response.ok)
      throw new AgentError('PROVIDER_HTTP', `Model endpoint returned HTTP ${response.status}`);
    return response;
  }
  override async *stream(request: ModelRequest): AsyncIterable<ModelResponse> {
    const response = await this.request(request, true);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      yield this.decode(await response.json());
      return;
    }
    let text = '';
    let usage: ModelUsage | undefined;
    let finished = false;
    const calls = new Map<
      number,
      { id: string; name: string; arguments: string; input: unknown }
    >();
    const eventSchema = z.object({
      type: z.string(),
      message: z.object({ usage: anthropicUsage.optional() }).optional(),
      usage: anthropicUsage.optional(),
      index: z.number().optional(),
      content_block: z
        .object({
          type: z.string(),
          id: z.string().optional(),
          name: z.string().optional(),
          input: z.unknown(),
          text: z.string().optional(),
        })
        .optional(),
      delta: z
        .object({
          type: z.string().optional(),
          text: z.string().optional(),
          partial_json: z.string().optional(),
          stop_reason: z.string().nullable().optional(),
        })
        .optional(),
    });
    for await (const raw of sse(response)) {
      const event = eventSchema.parse(raw);
      const stats = event.message?.usage ?? event.usage;
      if (stats)
        usage = {
          inputTokens:
            stats.input_tokens === undefined
              ? (usage?.inputTokens ?? 0)
              : stats.input_tokens +
                (stats.cache_creation_input_tokens ?? 0) +
                (stats.cache_read_input_tokens ?? 0),
          outputTokens: stats.output_tokens ?? usage?.outputTokens ?? 0,
        };
      if (event.type === 'error')
        throw new AgentError('PROVIDER_STREAM', 'Anthropic stream returned an error');
      if (event.type === 'message_stop') finished = true;
      if (event.delta?.stop_reason === 'max_tokens')
        throw new AgentError('MODEL_LENGTH', 'Model output limit reached');
      if (event.type === 'content_block_start') {
        if (event.content_block?.type === 'tool_use')
          calls.set(event.index!, {
            id: event.content_block.id!,
            name: event.content_block.name!,
            arguments: '',
            input: event.content_block.input,
          });
        else text += event.content_block?.text ?? '';
      }
      if (event.type === 'content_block_delta') {
        text += event.delta?.text ?? '';
        const call = calls.get(event.index!);
        if (call) call.arguments += event.delta?.partial_json ?? '';
      }
      yield { text, toolCalls: [], usage };
    }
    if (!finished)
      throw new AgentError('TRUNCATED_STREAM', 'Anthropic stream ended without message_stop');
    yield {
      text,
      usage,
      toolCalls: [...calls.values()].map((call) => ({
        id: call.id,
        name: call.name,
        input: call.arguments ? (JSON.parse(call.arguments) as unknown) : call.input,
      })),
    };
  }
  override async chat(request: ModelRequest): Promise<ModelResponse> {
    return this.decode(await (await this.request(request)).json());
  }
  private decode(raw: unknown): ModelResponse {
    const data = anthropicSchema.parse(raw);
    return {
      usage: data.usage
        ? {
            inputTokens:
              (data.usage.input_tokens ?? 0) +
              (data.usage.cache_creation_input_tokens ?? 0) +
              (data.usage.cache_read_input_tokens ?? 0),
            outputTokens: data.usage.output_tokens ?? 0,
          }
        : undefined,
      text: data.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n'),
      toolCalls: data.content
        .filter((c) => c.type === 'tool_use')
        .map((c) => ({ id: c.id, name: c.name, input: c.input })),
    };
  }
}
