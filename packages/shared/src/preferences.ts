import { z } from 'zod';

export const preferencesSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  language: z.enum(['en', 'zh-CN', 'ja']).default('en'),
});
export type AppPreferences = z.infer<typeof preferencesSchema>;
