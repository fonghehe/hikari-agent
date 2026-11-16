import { createHash } from 'node:crypto';
import { z } from 'zod';

export const operationSchema = z.object({
  id: z.string(),
  tool: z.string(),
  input: z.unknown(),
  key: z.string(),
  effect: z.enum(['read-only', 'idempotent', 'side-effect']),
  state: z.enum(['running', 'succeeded', 'failed', 'unknown', 'not-applied']),
  startedAt: z.string(),
  updatedAt: z.string(),
  detail: z.string().max(4000).optional(),
  recovered: z.boolean().optional(),
});
export type OperationRecord = z.infer<typeof operationSchema>;

export function operationKey(tool: string, input: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify([tool, canonical(input)]))
    .digest('hex');
}
