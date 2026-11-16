import { z } from 'zod';

export const providerIds = [
  'openai',
  'azure',
  'anthropic',
  'gemini',
  'deepseek',
  'qwen',
  'kimi',
  'glm',
  'doubao',
  'minimax',
  'siliconflow',
  'groq',
  'grok',
  'mistral',
  'openrouter',
  'ollama',
  'lmstudio',
  'compatible',
  'demo',
] as const;
export type ProviderId = (typeof providerIds)[number];
/** Official API documentation reviewed 2026-11-14. A chat subscription is not an API credential. */
export const providerApiDocs: Partial<Record<ProviderId, string>> = {
  openai: 'https://developers.openai.com/api/docs/quickstart',
  azure: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/switching-endpoints',
  anthropic: 'https://platform.claude.com/docs/en/api/overview',
  gemini: 'https://ai.google.dev/gemini-api/docs/quickstart',
  deepseek: 'https://api-docs.deepseek.com/',
  qwen: 'https://help.aliyun.com/zh/model-studio/first-api-call-to-qwen',
  kimi: 'https://platform.kimi.ai/docs/get-your-api-key',
  glm: 'https://docs.bigmodel.cn/cn/guide/start/introduction',
  doubao: 'https://www.volcengine.com/docs/82379/1330626',
  minimax: 'https://platform.minimax.io/docs/api-reference/api-overview',
  siliconflow: 'https://docs.siliconflow.cn/docs/api/chat-completions-post',
  groq: 'https://console.groq.com/docs/overview',
  grok: 'https://docs.x.ai/overview',
  mistral: 'https://docs.mistral.ai/api',
  openrouter: 'https://openrouter.ai/docs/quickstart',
  ollama: 'https://docs.ollama.com/api/openai-compatibility',
  lmstudio: 'https://lmstudio.ai/docs/developer/openai-compat',
};
export const providerCatalog: Record<
  ProviderId,
  {
    name: string;
    protocol: 'openai' | 'anthropic' | 'gemini' | 'demo';
    baseUrl: string;
    keyRequired: boolean;
  }
> = {
  azure: { name: 'Azure OpenAI / Foundry', protocol: 'openai', baseUrl: '', keyRequired: true },
  doubao: {
    name: 'Doubao / Volcano Ark',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyRequired: true,
  },
  minimax: {
    name: 'MiniMax',
    protocol: 'openai',
    baseUrl: 'https://api.minimax.io/v1',
    keyRequired: true,
  },
  siliconflow: {
    name: 'SiliconFlow',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyRequired: true,
  },
  groq: {
    name: 'Groq',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyRequired: true,
  },
  openai: {
    name: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyRequired: true,
  },
  anthropic: {
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyRequired: true,
  },
  gemini: {
    name: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    keyRequired: true,
  },
  deepseek: {
    name: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    keyRequired: true,
  },
  qwen: {
    name: 'Qwen / Model Studio',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyRequired: true,
  },
  kimi: {
    name: 'Kimi / Moonshot',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    keyRequired: true,
  },
  glm: {
    name: 'GLM / Zhipu',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyRequired: true,
  },
  grok: {
    name: 'Grok / xAI',
    protocol: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    keyRequired: true,
  },
  mistral: {
    name: 'Mistral',
    protocol: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    keyRequired: true,
  },
  openrouter: {
    name: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyRequired: true,
  },
  ollama: {
    name: 'Ollama',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyRequired: false,
  },
  lmstudio: {
    name: 'LM Studio',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    keyRequired: false,
  },
  compatible: { name: 'OpenAI compatible', protocol: 'openai', baseUrl: '', keyRequired: false },
  demo: { name: 'Offline demo', protocol: 'demo', baseUrl: '', keyRequired: false },
};
export const modelConfigSchema = z.object({
  provider: z.enum(providerIds),
  profileId: z.string().min(1).max(80).optional(),
  label: z.string().min(1).max(120).optional(),
  model: z.string().min(1).max(120),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().max(1000),
  supportsVision: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  contextWindow: z.number().int().min(8192).max(2000000).optional(),
  streaming: z.boolean().optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
  retries: z.number().int().min(1).max(5).optional(),
  includeUsage: z.boolean().optional(),
  tokenParameter: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  inputPerMillion: z.number().nonnegative().max(10000).optional(),
  outputPerMillion: z.number().nonnegative().max(10000).optional(),
  cachedInputPerMillion: z.number().nonnegative().max(10000).optional(),
  cacheWriteInputPerMillion: z.number().nonnegative().max(10000).optional(),
  maxOutputTokens: z.number().int().min(256).max(65536).optional(),
  searchUrl: z.string().url().optional(),
  embeddings: z
    .object({
      enabled: z.boolean(),
      model: z.string().min(1).max(120),
      baseUrl: z.string().url(),
      apiKey: z.string().max(1000),
      revision: z.string().max(120).optional(),
    })
    .optional(),
  reranker: z
    .object({
      enabled: z.boolean(),
      model: z.string().max(120),
      baseUrl: z.string().url(),
      apiKey: z.string().max(1000),
      timeoutMs: z.number().int().min(1000).max(60000).optional(),
    })
    .refine(
      (config) => !config.enabled || !!config.model.trim(),
      'An enabled reranker requires a model',
    )
    .optional(),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;
