import { z } from 'zod';
import type {
  AgentEvent,
  Task,
  Decision,
  RunOptions,
  Attachment,
  ModelImage,
} from '@hikari/agent-core';
export type { Attachment } from '@hikari/agent-core';
export const attachmentLimits = {
  maxFiles: 6,
  maxImages: 3,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxTextChars: 12000,
  maxTotalTextChars: 24000,
} as const;
export interface AttachmentUpload {
  name: string;
  bytes: Uint8Array;
}
export interface AttachmentBatch {
  items: Attachment[];
  errors: { name: string; message: string }[];
}
export interface AttachmentContent {
  attachment: Attachment;
  text?: string;
  image?: ModelImage;
  chunks?: { index: number; label: string; text: string }[];
  ocr?: boolean;
}
export const workspaceSchema = z.object({
  root: z.string(),
  name: z.string(),
  files: z.array(z.string()),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export interface WorkspaceProject {
  root: string;
  name: string;
  aliases?: string[];
  hidden?: boolean;
  pinned?: boolean;
  section?: string;
}
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
  maxOutputTokens: z.number().int().min(256).max(65536).optional(),
  searchUrl: z.string().url().optional(),
  embeddings: z
    .object({
      enabled: z.boolean(),
      model: z.string().min(1).max(120),
      baseUrl: z.string().url(),
      apiKey: z.string().max(1000),
    })
    .optional(),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export const preferencesSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  language: z.enum(['en', 'zh-CN', 'ja']).default('en'),
});
export type AppPreferences = z.infer<typeof preferencesSchema>;
export interface ChangeDTO {
  id: string;
  path: string;
  oldPath: string | null;
  reviewable?: boolean;
  binary?: boolean;
  exists?: boolean;
  beforeSize?: number;
  afterSize?: number;
  before: string | null;
  /** null when this change deleted the file. */
  after: string | null;
  accepted: boolean;
  undone: boolean;
}
export interface DesktopAPI {
  sections: {
    list(): Promise<string[]>;
    create(name: string): Promise<void>;
    rename(name: string, next: string): Promise<void>;
    remove(name: string): Promise<void>;
    markRead(name: string): Promise<void>;
    archive(name: string): Promise<number>;
  };
  platform: {
    list(workspaceRoot?: string): Promise<{
      automations: {
        id: string;
        name: string;
        prompt: string;
        enabled: boolean;
        nextAt: string;
        running?: boolean;
        last?: { status: string; result: string };
      }[];
      plugins: {
        name: string;
        version: string;
        description: string;
        sha256: string;
        source: string;
      }[];
      hooks: import('zod').output<typeof import('@hikari/agent-core').hookSchema>[];
      lsp: import('zod').output<typeof import('@hikari/agent-core').lspConfigSchema>[];
      remote?: { url: string; token: string };
    }>;
    schedule(input: unknown, workspaceRoot?: string): Promise<void>;
    updateSchedule(id: string, enabled: boolean | null, workspaceRoot?: string): Promise<void>;
    importPlugin(update?: boolean, workspaceRoot?: string): Promise<boolean>;
    removePlugin(name: string, workspaceRoot?: string): Promise<void>;
    registry(
      source: string,
      workspaceRoot?: string,
    ): Promise<
      { name: string; version: string; description: string; path: string; sha256: string }[]
    >;
    installRegistry(
      entry: { name: string; version: string; path: string; sha256: string },
      update?: boolean,
      workspaceRoot?: string,
    ): Promise<void>;
    configure(kind: 'hooks' | 'lsp', entries: unknown[], workspaceRoot?: string): Promise<void>;
    remoteStart(
      host?: string,
      port?: number,
      workspaceRoot?: string,
    ): Promise<{ url: string; token: string }>;
    remoteStop(workspaceRoot?: string): Promise<void>;
    timeline(taskId: string): Promise<{ id: string; taskId: string; label: string; at: string }[]>;
    previewRewind(
      taskId: string,
      checkpointId: string,
    ): Promise<{ diff: string; files: { path: string; conflict?: string }[]; applicable: boolean }>;
    rewind(
      taskId: string,
      checkpointId: string,
      mode: 'code' | 'conversation' | 'both',
    ): Promise<Task | undefined>;
  };
  attachments: {
    pick(): Promise<AttachmentBatch>;
    import(files: AttachmentUpload[]): Promise<AttachmentBatch>;
    read(id: string): Promise<AttachmentContent>;
  };
  extensions: {
    list(workspaceRoot?: string): Promise<{
      mcp: Record<
        string,
        { transport: 'stdio'; command: string; args: string[] } | { transport: 'http'; url: string }
      >;
      skills: { name: string; description: string; directory: string }[];
    }>;
    server(name: string, config: unknown | null, workspaceRoot?: string): Promise<void>;
    importSkill(workspaceRoot?: string): Promise<boolean>;
    removeSkill(directory: string, workspaceRoot?: string): Promise<void>;
  };
  updates: {
    status(): Promise<{ supported: boolean; version: string; state: string; message?: string }>;
    check(): Promise<void>;
    download(): Promise<void>;
    install(): Promise<void>;
  };
  maintenance: {
    status(): Promise<{
      schemaVersion: number;
      bytes: number;
      tables: Record<string, number>;
      pendingRestore: boolean;
      secureCredentials: boolean;
    }>;
    backup(): Promise<boolean>;
    restore(): Promise<boolean>;
    cancelRestore(): Promise<void>;
    diagnostics(): Promise<boolean>;
    prune(): Promise<boolean>;
  };
  clipboard: { write(text: string): Promise<void> };
  external: { open(url: string): Promise<void> };
  preferences: {
    get(): Promise<AppPreferences>;
    set(value: AppPreferences): Promise<AppPreferences>;
  };
  workspace: {
    pick(kind?: 'directory' | 'file'): Promise<string | null>;
    open(kind?: 'directory' | 'file'): Promise<Workspace | null>;
    add(input: { path: string; name?: string }): Promise<Workspace>;
    rename(root: string, name: string): Promise<WorkspaceProject>;
    organize(
      root: string,
      options: { pinned?: boolean; section?: string | null },
    ): Promise<WorkspaceProject>;
    archive(root: string): Promise<number>;
    remove(root: string): Promise<void>;
    clear(): Promise<void>;
    recent(): Promise<WorkspaceProject[]>;
    select(root: string): Promise<Workspace>;
    read(path: string, taskId?: string): Promise<string>;
    snapshot(taskId?: string): Promise<Workspace | null>;
  };
  agent: {
    configured(): Promise<boolean>;
    profiles(): Promise<ModelConfig[]>;
    activateProfile(id: string): Promise<void>;
    removeProfile(id: string): Promise<void>;
    settings(): Promise<ModelConfig | undefined>;
    configure(config: ModelConfig): Promise<void>;
    start(
      prompt: string,
      isolated?: boolean,
      parentTaskId?: string,
      options?: RunOptions,
      attachmentIds?: string[],
      section?: string,
    ): Promise<Task>;
    list(): Promise<Task[]>;
    rename(id: string, title: string): Promise<void>;
    organize(
      id: string,
      options: { pinned?: boolean; unread?: boolean; section?: string | null },
    ): Promise<void>;
    fork(id: string, title: string, isolated?: boolean): Promise<Task>;
    openWindow(id: string): Promise<void>;
    copy(
      id: string,
      format: 'title' | 'prompt' | 'answer' | 'conversation' | 'id',
    ): Promise<string>;
    openExternal(id: string, target: 'system' | 'vscode'): Promise<void>;
    archive(id: string, archived: boolean): Promise<void>;
    remove(id: string): Promise<void>;
    export(id: string): Promise<boolean>;
    import(): Promise<Task | undefined>;
    editMemory(
      scope: string,
      entry: { id: string; title: string; content: string; source?: string; expiresAt?: string },
    ): Promise<void>;
    grants(): Promise<{ id: string; description: string; updatedAt: string }[]>;
    revokeGrant(id: string): Promise<void>;
    control(id: string, action: 'pause' | 'resume' | 'cancel' | 'retry'): Promise<Task | undefined>;
    answer(taskId: string, questionId: string, answer: string): Promise<void>;
    input(taskId: string, text: string): Promise<void>;
    memories(scope: string): Promise<
      {
        id: string;
        title: string;
        content: string;
        updatedAt: string;
        source?: string;
        expiresAt?: string;
      }[]
    >;
    forget(scope: string, id: string): Promise<void>;
    models(config: ModelConfig): Promise<string[]>;
    test(config: ModelConfig): Promise<{ text: string; tools: boolean }>;
    approve(taskId: string, id: string, decision: Decision): Promise<void>;
    subscribe(listener: (event: AgentEvent) => void): () => void;
  };
  git: {
    diff(taskId?: string): Promise<string>;
    changes(taskId: string): Promise<ChangeDTO[]>;
    review(taskId: string, changeId: string, action: 'accept' | 'reject' | 'undo'): Promise<void>;
  };
  worktree: {
    preview(taskId: string): Promise<{
      id: string;
      files: {
        path: string;
        conflict?: string;
        beforeHash: string | null;
        afterHash: string | null;
      }[];
      diff: string;
      applicable: boolean;
    }>;
    apply(taskId: string, previewId: string): Promise<void>;
    archive(taskId: string): Promise<string>;
    restore(taskId: string): Promise<void>;
    undoDelivery(taskId: string): Promise<void>;
  };
  sync: {
    status(): Promise<{ email: string } | null>;
    connect(input: {
      url: string;
      email: string;
      password: string;
      register: boolean;
    }): Promise<{ id: string; email: string }>;
    push(taskId: string): Promise<number>;
    pull(): Promise<{ id: string; version: number; data: unknown; updatedAt: string }[]>;
    logout(): Promise<void>;
    import(id: string): Promise<Task>;
  };
  browser: { preview(taskId: string): Promise<{ url: string; image?: string }> };
  terminal: {
    create(taskId?: string): Promise<string>;
    write(id: string, data: string): Promise<void>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    kill(id: string): Promise<void>;
    subscribe(listener: (data: { id: string; data: string; exited?: boolean }) => void): () => void;
  };
}

/** Invoke-only channels; subscriptions use a separate event transport. */
export type DesktopInvokeChannel = {
  [
    Namespace in keyof DesktopAPI
  ]: `${Namespace}:${Exclude<keyof DesktopAPI[Namespace] & string, 'subscribe'>}`;
}[keyof DesktopAPI];
type DesktopInvokeMethod<Channel extends DesktopInvokeChannel> =
  Channel extends `${infer Namespace extends keyof DesktopAPI}:${infer Method}`
    ? Method extends keyof DesktopAPI[Namespace]
      ? DesktopAPI[Namespace][Method]
      : never
    : never;
export type DesktopInvokeArgs<Channel extends DesktopInvokeChannel> =
  DesktopInvokeMethod<Channel> extends (...args: infer Args) => unknown ? Args : never;
export type DesktopInvokeResult<Channel extends DesktopInvokeChannel> =
  DesktopInvokeMethod<Channel> extends (...args: never[]) => infer Result ? Result : never;

/** Main-process inputs stay untrusted until the handler validates them. */
type UntrustedArgs<Args extends unknown[]> = { [Index in keyof Args]: unknown };
export type DesktopInvokeRawArgs<Channel extends DesktopInvokeChannel> = UntrustedArgs<
  DesktopInvokeArgs<Channel>
>;
export type DesktopInvokeHandler<Channel extends DesktopInvokeChannel> = (
  ...args: DesktopInvokeRawArgs<Channel>
) => Awaited<DesktopInvokeResult<Channel>> | DesktopInvokeResult<Channel>;
