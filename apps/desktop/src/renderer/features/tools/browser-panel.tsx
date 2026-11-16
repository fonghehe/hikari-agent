import { useI18n } from '../../shared/i18n/index';
import { useEffect, useState } from 'react';
import { api, useStore, useTaskEvents } from '../../app/store';

export function BrowserPanel({ taskId }: { taskId: string }) {
  const { t } = useI18n();

  const [preview, setPreview] = useState<{ url: string; image?: string }>({ url: '' });
  const events = useTaskEvents(taskId);
  const task = useStore((state) => state.tasks.find((task) => task.id === taskId));
  const revision = events
    .filter(
      (event) =>
        event.taskId === taskId &&
        (event.type.startsWith('browser.') ||
          (event.type === 'tool.completed' && String(event.data.tool).startsWith('browser_'))),
    )
    .at(-1)?.id;
  useEffect(() => {
    let active = true;
    void api()
      .browser.preview(taskId)
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((error) => useStore.setState({ error: String(error) }));
    return () => {
      active = false;
    };
  }, [taskId, revision]);
  return (
    <div>
      {task?.demo && (
        <p className="muted">
          {t('Demo Q&A does not launch a browser. Connect a model for browser tools.')}
        </p>
      )}
      <p className="muted">{preview.url || t('Browser tools have not opened a page.')}</p>
      {preview.image ? (
        <img alt={t('Agent browser screenshot')} src={preview.image} style={{ width: '100%' }} />
      ) : (
        <p className="muted">{t('Ask the agent to take a screenshot to preview the page here.')}</p>
      )}
    </div>
  );
}
