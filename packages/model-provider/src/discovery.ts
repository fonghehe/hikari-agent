import { z } from 'zod';
import { AgentError } from '@hikari/agent-core';

const modelListSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});
const geminiModelListSchema = z.object({
  models: z
    .array(
      z.object({
        name: z.string(),
        supportedGenerationMethods: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});

/** Validate remote JSON before accessing model fields; never include the payload in errors. */
export function parseModelList(
  text: string,
  protocol: 'openai' | 'anthropic' | 'gemini',
): string[] {
  let ids: string[];
  try {
    const payload: unknown = JSON.parse(text);
    ids =
      protocol === 'gemini'
        ? geminiModelListSchema
            .parse(payload)
            .models.filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
            .map((model) => model.name.replace(/^models\//, ''))
        : modelListSchema.parse(payload).data.map((model) => model.id);
  } catch {
    throw new AgentError(
      'MODEL_DISCOVERY',
      'Model endpoint returned an invalid model list; enter a model ID manually.',
    );
  }
  return [...new Set(ids)]
    .filter((id) => id.trim().length > 0 && id.length <= 120)
    .sort()
    .slice(0, 2000);
}
