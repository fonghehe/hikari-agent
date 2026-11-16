import { useI18n } from '../../shared/i18n/index';
import { Answer } from './answer';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@hikari/ui';
import type { AgentEvent, PermissionRequest, Decision } from '@hikari/agent-core';
import { api, perform, useStore } from '../../app/store';

export function Timeline({ events }: { events: AgentEvent[] }) {
  const { t, locale } = useI18n();

  const taskId = useStore((s) => s.activeId);
  const visible = events.filter(
    (event) =>
      ![
        'agent.message.delta',
        'agent.state',
        'tool.stdout',
        'git.diff.updated',
        'plan.updated',
        'agent.run.summary',
        'agent.work.updated',
        'agent.intent',
        'superagent.report',
      ].includes(event.type),
  );
  const terminal = events.some((event) =>
    ['agent.completed', 'agent.failed', 'agent.cancelled'].includes(event.type),
  );
  const settledRequests = new Set(
    events
      .filter((event) => ['permission.approved', 'permission.denied'].includes(event.type))
      .map((event) => event.data.id),
  );
  const foreground = (event: AgentEvent) =>
    ['agent.completed', 'agent.failed', 'agent.cancelled', 'agent.handoff'].includes(event.type) ||
    (event.type === 'permission.requested' &&
      !terminal &&
      !settledRequests.has((event.data.request as unknown as PermissionRequest)?.id));
  const activity = visible.filter((event) => !foreground(event));
  const renderEvent = (event: AgentEvent) => {
    const request =
      event.type === 'permission.requested'
        ? (event.data.request as unknown as PermissionRequest)
        : null;
    const settled = request && settledRequests.has(request.id);
    return (
      <div
        key={event.id}
        data-event-type={event.type}
        className={`timeline-item ${event.type === 'agent.completed' ? 'success' : ''}`}
      >
        <span className="timeline-dot" />
        <details
          open={
            (!!request && !settled && !terminal) ||
            ['agent.completed', 'agent.failed', 'agent.cancelled'].includes(event.type)
          }
        >
          <summary>
            {event.type === 'agent.completed' ? <CheckCircle2 size={14} /> : null}
            {t(`event.${event.type}`)}
            {event.data.tool ? ` · ${String(event.data.tool)}` : ''}
            <time>{new Date(event.timestamp).toLocaleTimeString(locale)}</time>
          </summary>
          {['agent.completed', 'agent.message.delta', 'agent.handoff'].includes(event.type) ? (
            <Answer text={String(event.data.text)} />
          ) : (
            <pre>{JSON.stringify(event.data, null, 2)}</pre>
          )}
          {request && !settled && !terminal && (
            <div className="approval">
              <p>
                {t(
                  'Approve this operation? Commands and external tools run with your user account permissions.',
                )}
              </p>
              {(['once', 'session', 'always', 'deny'] as Decision[]).map((decision) => (
                <Button
                  key={decision}
                  variant={decision === 'deny' ? 'ghost' : 'outline'}
                  onClick={() =>
                    void perform(() => api().agent.approve(taskId!, request.id, decision))
                  }
                >
                  {
                    {
                      once: t('Allow once'),
                      session: t('Allow for session'),
                      always: t('Always allow'),
                      deny: t('Deny'),
                    }[decision]
                  }
                </Button>
              ))}
            </div>
          )}
        </details>
      </div>
    );
  };
  return (
    <div className="timeline">
      {activity.length > 0 && (
        <details className="agent-activity">
          <summary>{t('Activity ({count})', { count: activity.length })}</summary>
          {activity.map(renderEvent)}
        </details>
      )}
      {visible.filter(foreground).map(renderEvent)}
    </div>
  );
}
