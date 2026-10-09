import {
  AgentError,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type Message,
} from '@hikari/agent-core';
import { modelConfigSchema, providerCatalog, type ModelConfig } from '@hikari/shared';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { AnthropicProvider, OpenAICompatibleProvider, DemoProvider } from './index';
import { providerFetch } from './http';

export function validateEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new AgentError(
      'INVALID_ENDPOINT',
      'Use an HTTPS or localhost base URL without credentials, query or fragment',
    );
  return url.toString().replace(/\/$/, '');
}
export function resolvedModelConfig(value: ModelConfig): ModelConfig {
  const config = modelConfigSchema.parse(value);
  const preset = providerCatalog[config.provider];
  if (preset.protocol === 'demo') return config;
  if ((config.maxOutputTokens ?? 4096) >= (config.contextWindow ?? 64000))
    throw new AgentError(
      'MODEL_CONTEXT',
      'Maximum output tokens must be smaller than the context window',
    );
  if (!(config.baseUrl || preset.baseUrl))
    throw new AgentError('INVALID_ENDPOINT', 'Enter the base URL supplied by your model service');
  const baseUrl = validateEndpoint(config.baseUrl || preset.baseUrl);
  if (preset.keyRequired && !config.apiKey.trim())
    throw new AgentError('API_KEY_REQUIRED', 'Enter an API key for this provider');
  return {
    ...config,
    baseUrl,
    tokenParameter:
      config.tokenParameter ??
      (config.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'),
  };
}
function encodeGemini(message: Message): BaseMessage {
  if (message.role === 'system') return new SystemMessage(message.content);
  if (message.role === 'tool')
    return new ToolMessage({ content: message.content, tool_call_id: message.toolCallId! });
  if (message.role === 'assistant') {
    const raw = message.providerData?.gemini as
      | { content?: AIMessage['content']; additional_kwargs?: AIMessage['additional_kwargs'] }
      | undefined;
    return new AIMessage({
      content: raw?.content ?? message.content,
      additional_kwargs: raw?.additional_kwargs,
      tool_calls: message.toolCalls?.map((call) => ({
        id: call.id,
        name: call.name,
        args: call.input as Record<string, unknown>,
        type: 'tool_call' as const,
      })),
    });
  }
  return new HumanMessage({
    content: message.images?.length
      ? [
          { type: 'text', text: message.content },
          ...message.images.map((image) => ({
            type: 'image_url',
            image_url: `data:${image.mimeType};base64,${image.data}`,
          })),
        ]
      : message.content,
  });
}
function decodeGemini(message: AIMessageChunk): ModelResponse {
  if (message.invalid_tool_calls?.length)
    throw new AgentError('INVALID_TOOL_CALL', 'Gemini returned an invalid tool call');
  if (message.response_metadata?.finishReason === 'MAX_TOKENS')
    throw new AgentError('MODEL_LENGTH', 'Model output limit reached before completion');
  return {
    text:
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part) => part.type === 'text' && !part.thought)
            .map((part) => part.text)
            .join(''),
    toolCalls: (message.tool_calls ?? []).map((call) => ({
      id: call.id!,
      name: call.name,
      input: call.args,
    })),
    usage: message.usage_metadata
      ? {
          inputTokens: message.usage_metadata.input_tokens,
          outputTokens: message.usage_metadata.output_tokens,
        }
      : undefined,
    providerData: {
      gemini: { content: message.content, additional_kwargs: message.additional_kwargs },
    },
  };
}
export class GeminiProvider implements ModelProvider {
  constructor(private config: ModelConfig) {}
  countTokens(text: string) {
    return Math.ceil(new TextEncoder().encode(text).length / 3);
  }
  private model(request: ModelRequest) {
    const llm = new ChatGoogleGenerativeAI({
      model: this.config.model.replace(/^models\//, ''),
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      maxOutputTokens: request.maxOutputTokens ?? this.config.maxOutputTokens ?? 4096,
      maxRetries: (this.config.retries ?? 3) - 1,
      streamUsage: true,
    });
    return request.tools.length
      ? llm.bindTools(request.tools.map((tool) => ({ type: 'function' as const, function: tool })))
      : llm;
  }
  async chat(request: ModelRequest) {
    return decodeGemini(
      await this.model(request).invoke(request.messages.map(encodeGemini), {
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(this.config.timeoutMs ?? 120000),
        ]),
      }),
    );
  }
  async *stream(request: ModelRequest) {
    let result: AIMessageChunk | undefined;
    for await (const chunk of await this.model(request).stream(request.messages.map(encodeGemini), {
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(this.config.timeoutMs ?? 120000),
      ]),
    })) {
      result = result ? result.concat(chunk) : chunk;
      // Partial JSON arguments must never be executed.
      yield {
        ...decodeGemini(
          new AIMessageChunk({ content: result.content, usage_metadata: result.usage_metadata }),
        ),
        toolCalls: [],
      };
    }
    if (!result) throw new AgentError('TRUNCATED_STREAM', 'Gemini returned an empty stream');
    yield decodeGemini(result);
  }
}
class CapabilityProvider implements ModelProvider {
  constructor(
    private provider: ModelProvider,
    private config: ModelConfig,
  ) {}
  countTokens(text: string) {
    return this.provider.countTokens(text);
  }
  chat(request: ModelRequest) {
    return this.provider.chat({
      ...request,
      tools: this.config.supportsTools === false ? [] : request.tools,
    });
  }
  async *stream(request: ModelRequest) {
    const next = { ...request, tools: this.config.supportsTools === false ? [] : request.tools };
    if (this.config.streaming === false) yield await this.provider.chat(next);
    else yield* this.provider.stream(next);
  }
}
export function createModelProvider(value: ModelConfig): ModelProvider {
  const config = resolvedModelConfig(value);
  const protocol = providerCatalog[config.provider].protocol;
  const provider =
    protocol === 'demo'
      ? new DemoProvider()
      : protocol === 'gemini'
        ? new GeminiProvider(config)
        : protocol === 'anthropic'
          ? new AnthropicProvider(config)
          : new OpenAICompatibleProvider({
              ...config,
              authType: config.provider === 'azure' ? 'api-key' : 'bearer',
              inlineReasoning: config.provider === 'minimax',
            });
  return new CapabilityProvider(provider, config);
}
export async function listModels(
  value: ModelConfig,
  signal = AbortSignal.timeout(30000),
): Promise<string[]> {
  const config = resolvedModelConfig(value);
  const protocol = providerCatalog[config.provider].protocol;
  if (protocol === 'demo') return ['offline-demo'];
  const url =
    protocol === 'gemini'
      ? `${config.baseUrl}/v1beta/models?pageSize=1000`
      : `${config.baseUrl}/models`;
  const headers: Record<string, string> =
    protocol === 'gemini'
      ? { 'x-goog-api-key': config.apiKey }
      : protocol === 'anthropic'
        ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }
        : config.provider === 'azure'
          ? { 'api-key': config.apiKey }
          : { Authorization: `Bearer ${config.apiKey}` };
  const response = await providerFetch(url, { headers, signal }, config.retries ?? 3);
  if (!response.ok)
    throw new AgentError(
      'MODEL_DISCOVERY',
      `Model listing returned HTTP ${response.status}; enter a model ID manually if the endpoint does not provide a list.`,
    );
  if (!response.body) throw new AgentError('MODEL_DISCOVERY', 'Model list is empty');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2000000)
        throw new AgentError('MODEL_DISCOVERY', 'Model list exceeds the size limit');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const payload = JSON.parse(text) as {
    data?: { id: string }[];
    models?: { name: string; supportedGenerationMethods?: string[] }[];
  };
  return [
    ...new Set(
      protocol === 'gemini'
        ? (payload.models ?? [])
            .filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
            .map((model) => model.name.replace(/^models\//, ''))
        : (payload.data ?? []).map((model) => model.id),
    ),
  ]
    .filter((id) => typeof id === 'string' && id.length <= 120)
    .sort()
    .slice(0, 2000);
}
