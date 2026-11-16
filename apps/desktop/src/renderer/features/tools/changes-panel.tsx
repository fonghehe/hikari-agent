import { CodePanel } from './code-panel';
import { useI18n } from '../../shared/i18n/index';
import { useEffect, useState } from 'react';
import { Button } from '@hikari/ui';
import { api, perform, useStore, useTaskEvents } from '../../app/store';
import { type ChangeDTO } from '@hikari/shared';

export function ChangesPanel({ taskId }: { taskId: string }) {
  const { t } = useI18n();

  const [changes, setChanges] = useState<ChangeDTO[]>([]);
  const events = useTaskEvents(taskId);
  const [selected, setSelected] = useState<string>();
  const [reviewing, setReviewing] = useState(false);
  const task = useStore((state) => state.tasks.find((task) => task.id === taskId));
  const revision = events
    .filter(
      (event) =>
        event.taskId === taskId &&
        ['file.changed', 'git.reviewed', 'agent.completed'].includes(event.type),
    )
    .at(-1)?.id;
  const review = async (id: string, action: 'accept' | 'reject' | 'undo') => {
    if (reviewing) return;
    setReviewing(true);
    await perform(async () => {
      await api().git.review(taskId, id, action);
      setChanges(await api().git.changes(taskId));
    });
    setReviewing(false);
  };
  useEffect(() => {
    let disposed = false;
    void api()
      .git.changes(taskId)
      .then((value) => {
        if (!disposed) setChanges(value);
      })
      .catch((error) => useStore.setState({ error: String(error) }));
    return () => {
      disposed = true;
    };
  }, [taskId, revision]);
  const current = changes.find((c) => c.id === selected);
  return (
    <>
      {task?.demo && (
        <p className="muted">
          {t('Simulated Diff · Accept / Reject / Undo affect sample data only.')}
        </p>
      )}
      {task && !['completed', 'failed', 'cancelled', 'paused'].includes(task.status) && (
        <p className="muted">{t('Pause or finish the task before reviewing changes.')}</p>
      )}
      {changes.length === 0 && <p className="muted">{t('No file changes yet.')}</p>}
      {changes.map((change) => (
        <div key={change.id} className="change-row">
          <button onClick={() => setSelected(change.id)}>
            {change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
            {change.exists === false || (change.exists === undefined && change.after === null)
              ? ` ${t('(deleted)')}`
              : ''}
          </button>
          {change.undone ? (
            <span>{t('Undone')}</span>
          ) : (
            <>
              {change.accepted ? (
                <span>{t('Accepted')}</span>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    disabled={
                      reviewing ||
                      change.reviewable === false ||
                      !task ||
                      !['completed', 'failed', 'cancelled', 'paused'].includes(task.status)
                    }
                    onClick={() => void review(change.id, 'accept')}
                  >
                    {t('Accept')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={
                      reviewing ||
                      change.reviewable === false ||
                      !task ||
                      !['completed', 'failed', 'cancelled', 'paused'].includes(task.status)
                    }
                    onClick={() => void review(change.id, 'reject')}
                  >
                    {t('Reject')}
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                disabled={
                  reviewing ||
                  change.reviewable === false ||
                  !task ||
                  !['completed', 'failed', 'cancelled', 'paused'].includes(task.status)
                }
                onClick={() => void review(change.id, 'undo')}
              >
                {t('Undo')}
              </Button>
            </>
          )}
        </div>
      ))}
      {current?.reviewable === false && (
        <p className="muted">
          {t(
            'Large or binary change · review with an external editor. In-app undo is unavailable.',
          )}
        </p>
      )}
      {current && current.reviewable !== false && (
        <CodePanel content={current.after ?? ''} original={current.before ?? ''} />
      )}
    </>
  );
}
