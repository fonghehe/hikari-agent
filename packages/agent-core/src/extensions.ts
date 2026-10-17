import { z } from 'zod';
export const hookSchema = z.object({
  id: z.string().regex(/^[\w-]{1,80}$/),
  event: z.enum(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']),
  tool: z.string().max(120).optional(),
  command: z.string().min(1).max(2000),
  args: z.array(z.string().max(4000)).max(100).default([]),
  timeoutMs: z.number().int().min(100).max(120000).default(30000),
});
export const lspConfigSchema = z.object({
  name: z.string().regex(/^[\w-]{1,80}$/),
  command: z.string().min(1).max(2000),
  args: z.array(z.string().max(2000)).max(100).default([]),
  extensions: z
    .array(z.string().regex(/^\.[\w]+$/))
    .min(1)
    .max(30),
  languageId: z.string().min(1).max(80),
});
export const agentDefinitionSchema = z.object({
  name: z.string().regex(/^[\w-]{1,80}$/),
  description: z.string().min(1).max(1000),
  instructions: z.string().min(1).max(12000),
  writable: z.boolean().default(false),
});
export const pluginManifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
  description: z.string().min(1).max(1000),
  skills: z
    .array(z.string().regex(/^[\w/-]+$/))
    .max(30)
    .default([]),
  hooks: z.array(hookSchema).max(30).default([]),
  agents: z.array(agentDefinitionSchema).max(20).default([]),
  lsp: z.array(lspConfigSchema).max(10).default([]),
  mcp: z
    .record(
      z.discriminatedUnion('transport', [
        z.object({
          transport: z.literal('stdio'),
          command: z.string(),
          args: z.array(z.string()).default([]),
        }),
        z.object({ transport: z.literal('http'), url: z.string().url() }),
      ]),
    )
    .default({}),
});
export type PluginManifest = z.output<typeof pluginManifestSchema>;
