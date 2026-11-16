import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { Task, RunSummary, TaskDelivery } from '@hikari/agent-core';
import { redactText } from '@hikari/agent-core';
import type { SandboxProvider } from '@hikari/sandbox';

/** Runtime evidence stays distinct from agent-proposed links and completion prose. */
export async function buildTaskDelivery(
  task: Task,
  summary: RunSummary,
  sandbox: SandboxProvider,
  unknownOperations: string[] = [],
): Promise<TaskDelivery> {
  const checks = summary.verification?.checks ?? [];
  const verification: TaskDelivery['verification'] =
    task.status === 'failed' || summary.verification?.passed === false
      ? 'failed'
      : checks.length && summary.verification?.passed
        ? 'verified'
        : (task.chat || task.runOptions?.mode === 'plan') && !summary.filesChanged.length
          ? 'not-required'
          : 'unverified';
  const delivery: TaskDelivery = {
    generatedAt: new Date().toISOString(),
    verification,
    artifacts: [],
    evidence: checks.map((check) => ({
      ...check,
      detail: redactText(check.detail).slice(0, 4000),
    })),
    unfinished: [
      ...(task.workReport?.unfinished ?? []),
      ...unknownOperations.map((tool) => `Unknown operation outcome: ${tool}`),
    ],
    limitations: [...(task.workReport?.limitations ?? [])],
  };
  if (unknownOperations.length && delivery.verification !== 'failed')
    delivery.verification = 'unverified';
  if (verification === 'unverified')
    delivery.limitations.push('No independent acceptance evidence verifies this result.');
  const proposals = [
    ...summary.filesChanged.map((locator) => ({ kind: 'file' as const, locator, label: locator })),
    ...(task.workReport?.artifacts ?? []),
  ];
  const unique = [
    ...new Map(
      proposals.map((artifact) => [`${artifact.kind}:${artifact.locator}`, artifact]),
    ).values(),
  ];
  if (unique.length > 64)
    delivery.limitations.push('Only the first 64 artifact records are included.');
  for (const artifact of unique.slice(0, 64)) {
    if (artifact.kind === 'url') {
      try {
        const url = new URL(artifact.locator);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
        delivery.artifacts.push({
          ...artifact,
          locator: redactText(url.href),
          state: 'unverified',
        });
      } catch {
        /* Invalid proposed URLs are not deliverables. */
      }
      continue;
    }
    try {
      const file = await sandbox.resolve(task.worktree ?? task.workspace, artifact.locator);
      const info = await stat(file);
      if (!info.isFile() || info.size > 2000000)
        throw new Error('Artifact exceeds bounded file verification');
      delivery.artifacts.push({
        ...artifact,
        state: 'recorded',
        sha256: createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      });
    } catch {
      delivery.artifacts.push({ ...artifact, state: 'unavailable' });
    }
  }
  const answer = task.events.filter((event) => event.type === 'agent.completed').at(-1);
  if (answer && typeof answer.data.text === 'string')
    delivery.artifacts.push({
      kind: 'answer',
      locator: answer.id,
      label: 'Final answer',
      state: 'recorded',
      sha256: createHash('sha256').update(answer.data.text).digest('hex'),
    });
  delivery.unfinished.push(
    ...(task.plan?.steps.filter((step) => step.status !== 'completed').map((step) => step.text) ??
      []),
  );
  if (task.status === 'interrupted')
    delivery.humanAction = {
      kind: 'resume',
      label: 'Inspect saved state and resume the task.',
      taskId: task.id,
    };
  else if (task.workReport?.humanAction)
    delivery.humanAction = {
      kind: 'answer',
      label: task.workReport.humanAction.question,
      taskId: task.id,
    };
  else if (
    task.status === 'failed' ||
    unknownOperations.length ||
    task.workReport?.status === 'blocked'
  )
    delivery.humanAction = {
      kind: 'inspect',
      label: 'Inspect the failure or unknown outcome before retrying.',
      taskId: task.id,
    };
  else if (summary.filesChanged.length || task.workReport?.reviewRequired)
    delivery.humanAction = {
      kind: 'review',
      label: 'Review the deliverables and accept or undo the changes.',
      taskId: task.id,
    };
  delivery.unfinished = [...new Set(delivery.unfinished)]
    .slice(0, 20)
    .map((text) => redactText(text));
  delivery.limitations = [...new Set(delivery.limitations)]
    .slice(0, 20)
    .map((text) => redactText(text));
  delivery.artifacts = delivery.artifacts.map((artifact) => ({
    ...artifact,
    locator: redactText(artifact.locator),
    label: redactText(artifact.label),
  }));
  return delivery;
}
