import { useI18n } from '../../shared/i18n/index';
import type { AgentEvent, Task, TaskPlan, RunSummary } from '@hikari/agent-core';
import { Button } from '@hikari/ui';

export function TaskProgress({
  task,
  events,
  onExecutePlan,
  onReview,
}: {
  task: Task;
  events: AgentEvent[];
  onExecutePlan(): void;
  onReview(): void;
}) {
  const { t } = useI18n();

  const last = (type: string) =>
    events
      .slice()
      .reverse()
      .find((event) => event.type === type);
  const plan = (last('plan.updated')?.data as TaskPlan | undefined) ?? task.plan;
  const summary = (last('agent.run.summary')?.data as RunSummary | undefined) ?? task.runSummary;
  const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
  const latestTests = new Map<string, NonNullable<RunSummary['tests']>[number]>();
  for (const test of summary?.tests ?? []) latestTests.set(`${test.cwd}:${test.command}`, test);
  const checks = [...latestTests.values()];
  const verification =
    checks.length === 0
      ? t('No tests run')
      : checks.some((test) => test.status === 'failed')
        ? t('Checks failed')
        : checks.some((test) => test.status === 'not_run')
          ? t('Checks not fully run')
          : t('Recorded checks passed');
  const workflow = events.filter((event) => event.type === 'workflow.stage').at(-1);
  return (
    <>
      {task.delivery && (
        <section className="run-evidence" aria-label={t('Delivery record')}>
          <details open={task.delivery.unfinished.length > 0}>
            <summary>
              {t('Delivery record')} ·{' '}
              {t(
                {
                  verified: 'Configured acceptance passed',
                  'not-required': 'Execution acceptance not required',
                  unverified: 'Not independently verified',
                  failed: 'Execution or acceptance failed',
                }[task.delivery.verification],
              )}
            </summary>
            {task.delivery.artifacts.length > 0 && (
              <ul>
                {task.delivery.artifacts.map((artifact, index) => (
                  <li key={index}>
                    {t(artifact.label)} ·{' '}
                    <code>{artifact.kind === 'answer' ? t('Final answer') : artifact.locator}</code>{' '}
                    ·{' '}
                    {t(
                      {
                        recorded: 'Current content recorded',
                        unavailable: 'Deleted or unreadable',
                        unverified: 'Link not verified',
                      }[artifact.state],
                    )}
                  </li>
                ))}
              </ul>
            )}
            {task.delivery.unfinished.length > 0 && (
              <>
                <strong>{t('Unfinished items')}</strong>
                <ul>
                  {task.delivery.unfinished.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </>
            )}
            {task.delivery.limitations.length > 0 && (
              <>
                <strong>{t('Verification limits')}</strong>
                <ul>
                  {task.delivery.limitations.map((item, index) => (
                    <li key={index}>{t(item)}</li>
                  ))}
                </ul>
              </>
            )}
            {task.delivery.humanAction && (
              <p>
                {task.delivery.humanAction.kind === 'review' ? (
                  <Button variant="outline" onClick={onReview}>
                    {t('Review deliverables')}
                  </Button>
                ) : (
                  t(task.delivery.humanAction.label)
                )}
              </p>
            )}
          </details>
        </section>
      )}
      {workflow && (
        <p className="workflow-progress">
          {t('Workflow')} · {t(`workflow.${String(workflow.data.stage)}`)} · {t('Review round')}{' '}
          {Number(workflow.data.round) + 1}
        </p>
      )}
      {plan && (
        <section className="task-plan" aria-label={t('Task plan')}>
          <div className="progress-heading">
            <strong>{t('Plan')}</strong>
            <span>
              {plan.steps.filter((step) => step.status === 'completed').length}/{plan.steps.length}
            </span>
          </div>
          {plan.explanation && <p className="muted">{plan.explanation}</p>}
          <ol>
            {plan.steps.map((step) => (
              <li key={step.id} data-status={step.status}>
                <span aria-label={t(`status.${step.status}`)}>
                  {step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '◉' : '○'}
                </span>
                {step.text}
              </li>
            ))}
          </ol>
          {terminal && task.runOptions?.mode === 'plan' && (
            <Button variant="outline" onClick={onExecutePlan}>
              {t('Use plan in Execute')}
            </Button>
          )}
          <small>{t('Plan progress is agent-reported. Check execution evidence below.')}</small>
        </section>
      )}
      {summary && (
        <section className="run-evidence" aria-label={t('Execution evidence')}>
          <div className="progress-heading">
            <strong>{task.demo ? t('Simulation summary') : t('Execution evidence')}</strong>
            <span>{verification}</span>
          </div>
          <details className="run-details">
            <summary>{t('Run details')}</summary>
            <p className="muted">
              {t('{turns} {kind} · {tools} tool requests · {failures} failures · {seconds}s', {
                turns: summary.modelSteps,
                kind: t(task.demo ? 'scripted turns' : 'model turns'),
                tools: summary.toolCalls,
                failures: summary.toolFailures,
                seconds: (summary.durationMs / 1000).toFixed(1),
              })}
            </p>
            {summary.inputTokens !== undefined && (
              <p>
                {t('Token usage')}: {summary.inputTokens} / {summary.outputTokens ?? 0}{' '}
                {summary.usageEstimated ? t('(estimated)') : t('(provider reported)')}
                {summary.costUsd !== undefined &&
                  ` · $${summary.costUsd.toFixed(4)} ${t('(configured pricing)')}`}
              </p>
            )}
            {summary.attention && (
              <p>
                {t('Human interventions')}: {summary.attention.interventions} · {t('Waiting time')}:{' '}
                {(summary.attention.waitingMs / 1000).toFixed(1)}s · {t('Active time')}:{' '}
                {((summary.activeDurationMs ?? 0) / 1000).toFixed(1)}s
              </p>
            )}
            {summary.costUsd !== undefined && (
              <small>
                {t('Model costs only; other service fees and unknown billing are excluded.')}
              </small>
            )}
            {summary.tests.length > 0 && (
              <details>
                <summary>{t('Check attempts ({count})', { count: summary.tests.length })}</summary>
                <ul>
                  {summary.tests.map((test, index) => (
                    <li key={index}>
                      <strong>{t(`status.${test.status}`)}</strong> · {t('exit')}{' '}
                      {test.exitCode ?? '—'} · {(test.durationMs / 1000).toFixed(1)}s
                      <code>{test.command}</code>
                      <small>
                        {t('cwd')}: {test.cwd}
                      </small>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <small>
              {task.demo
                ? t(
                    'Offline simulation only. No real tests, commands or local file changes were performed.',
                  )
                : t(
                    'Only run_tests calls are recorded checks. This is execution evidence, not a guarantee of code correctness.',
                  )}
            </small>
          </details>
          {summary.verification && (
            <details open={!summary.verification.passed}>
              <summary>
                {t(summary.verification.passed ? 'Acceptance passed' : 'Acceptance failed')}
              </summary>
              <ul>
                {summary.verification.checks.map((check) => (
                  <li key={check.id}>
                    {check.passed ? '✓' : '✕'} {check.label}
                    <small>{check.detail}</small>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {summary.stopReason && (
            <p className="stop-reason">{t('Stopped: {reason}', { reason: summary.stopReason })}</p>
          )}
          {summary.filesChanged.length > 0 && (
            <Button variant="outline" onClick={onReview}>
              {t('Review {count} tracked file changes', { count: summary.filesChanged.length })}
            </Button>
          )}
        </section>
      )}
    </>
  );
}
