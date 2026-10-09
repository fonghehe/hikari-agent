import { z } from 'zod';

export const acceptanceCheckSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(300),
    kind: z.literal('test'),
    command: z.string().min(1).max(2000),
    args: z.array(z.string().max(2000)).max(100).default([]),
    cwd: z.string().max(2000).default('.'),
  }),
  z.object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(300),
    kind: z.literal('file'),
    path: z.string().min(1).max(2000),
    contains: z.string().max(12000).optional(),
    exists: z.boolean().default(true),
  }),
]);
export type AcceptanceCheck = z.infer<typeof acceptanceCheckSchema>;
export interface VerificationReport {
  passed: boolean;
  checks: { id: string; label: string; passed: boolean; detail: string }[];
}
export const runOptionsSchema = z.object({
  mode: z.enum(['execute', 'plan']).default('execute'),
  workflow: z.enum(['standard', 'development']).optional(),
  worktreeSource: z.enum(['head', 'working-tree']).optional(),
  maxSteps: z.number().int().min(1).max(100).default(30),
  checks: z
    .array(acceptanceCheckSchema)
    .max(12)
    .refine(
      (checks) => new Set(checks.map((check) => check.id)).size === checks.length,
      'Acceptance check IDs must be unique',
    )
    .optional(),
  requireTests: z.boolean().optional(),
  maxTokens: z.number().int().min(1000).max(10000000).optional(),
  maxCostUsd: z.number().positive().max(10000).optional(),
  maxDurationMs: z.number().int().min(1000).max(86400000).optional(),
  execution: z.enum(['restricted', 'host']).optional(),
  allowNetwork: z.boolean().optional(),
});
export type RunOptions = z.infer<typeof runOptionsSchema>;
export const taskPlanSchema = z
  .object({
    explanation: z.string().max(2000).optional(),
    steps: z
      .array(
        z.object({
          id: z.string().min(1).max(80),
          text: z.string().min(1).max(500),
          status: z.enum(['pending', 'in_progress', 'completed']),
        }),
      )
      .min(1)
      .max(20),
  })
  .refine(
    (plan) => new Set(plan.steps.map((step) => step.id)).size === plan.steps.length,
    'Plan step IDs must be unique',
  )
  .refine(
    (plan) => plan.steps.filter((step) => step.status === 'in_progress').length <= 1,
    'Only one plan step can be in progress',
  );
export type TaskPlan = z.infer<typeof taskPlanSchema>;

export const runSummarySchema = z.object({
  modelSteps: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolFailures: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  filesChanged: z.array(z.string()).max(2000),
  tests: z
    .array(
      z.object({
        command: z.string(),
        cwd: z.string(),
        status: z.enum(['passed', 'failed', 'not_run']),
        exitCode: z.number().int().nullable(),
        durationMs: z.number().nonnegative(),
      }),
    )
    .max(2000),
  stopReason: z.string().optional(),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  usageEstimated: z.boolean().optional(),
  costUsd: z.number().nonnegative().optional(),
  verification: z
    .object({
      passed: z.boolean(),
      checks: z.array(
        z.object({ id: z.string(), label: z.string(), passed: z.boolean(), detail: z.string() }),
      ),
    })
    .optional(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

// A fixed capability set rather than a prompt-only promise. New tools default to excluded.
export const planningTools: ReadonlySet<string> = new Set([
  'find_symbol',
  'file_summary',
  'repository_map',
  'project_instructions',
  'read_file',
  'list_directory',
  'glob',
  'grep',
  'search_code',
  'git_status',
  'git_diff',
  'git_log',
  'git_branch',
  'list_skills',
  'load_skill',
  'list_mcp_servers',
  'update_plan',
  'update_task_summary',
  'ask_user',
  'search_memory',
  'search_attachments',
  'read_attachment',
]);

export const modeInstruction = (mode: RunOptions['mode']) =>
  mode === 'plan'
    ? 'PLAN MODE: inspect and propose a concrete plan with update_plan. Do not edit files, run commands, access browsers or connect external tools. Execution requires the user to start a separate Execute turn.'
    : 'For multi-step tasks use update_plan, keep at most one step in progress, and update it as work proceeds. Final answers must distinguish verified checks from checks not run.';
