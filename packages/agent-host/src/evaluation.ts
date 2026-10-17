import path from 'node:path';
import { z } from 'zod';

const relativeFile = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (name) =>
      !path.isAbsolute(name) &&
      !name.includes('\\') &&
      name.split('/').every((part) => part && part !== '..' && part !== '.') &&
      !['.git', '.agent'].includes(name.split('/')[0]!),
    'Use a project-relative file path',
  );
export const evaluationCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).max(100).default([]),
  timeoutMs: z.number().int().min(100).max(300000).default(30000),
});
export const repositorySuiteSchema = z
  .object({
    cases: z
      .array(
        z.object({
          name: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
          repository: z.string().min(1),
          commit: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/),
          prompt: z.string().trim().min(1).max(24000),
          setup: z.array(evaluationCommandSchema).max(5).default([]),
          setupNetwork: z.boolean().default(false),
          grader: evaluationCommandSchema,
          allowedPaths: z.array(relativeFile).min(1).max(200),
          preservePaths: z.array(relativeFile).min(1).max(200),
        }),
      )
      .min(1)
      .max(100),
  })
  .superRefine((suite, context) => {
    if (new Set(suite.cases.map((item) => item.name)).size !== suite.cases.length)
      context.addIssue({ code: 'custom', message: 'Case names must be unique' });
    for (const item of suite.cases)
      if (item.allowedPaths.some((name) => item.preservePaths.includes(name)))
        context.addIssue({
          code: 'custom',
          message: `${item.name}: allowedPaths overlaps preservePaths`,
        });
  });

export type EvaluationCommand = z.infer<typeof evaluationCommandSchema>;
