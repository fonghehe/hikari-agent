import { useEffect, useState } from 'react';
import type { DesktopAPI } from '@hikari/shared';
import { Button } from '@hikari/ui';
import { api, perform } from './store';
import { useI18n } from './i18n';

export function DataSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<Awaited<ReturnType<DesktopAPI['maintenance']['status']>>>();
  const [busy, setBusy] = useState(false);
  const refresh = async () => setStatus(await api().maintenance.status());
  useEffect(() => {
    let active = true;
    void perform(async () => {
      const result = await api().maintenance.status();
      if (active) setStatus(result);
    });
    return () => {
      active = false;
    };
  }, []);
  const action = (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void perform(async () => {
      await work();
      await refresh();
    }).finally(() => setBusy(false));
  };
  return (
    <section className="settings-section">
      <h3>{t('Data and diagnostics')}</h3>
      <p>
        {t(
          'Backups contain private data. Project files are not included. Restoring applies on next startup and first saves the current database.',
        )}
      </p>
      {status && (
        <>
          <p>
            {t('Database size')}: {(status.bytes / 1048576).toFixed(1)} MB · {t('Saved tasks')}:{' '}
            {status.tables.tasks ?? 0}
          </p>
          <p>
            {t(
              status.secureCredentials
                ? 'Protected credential storage available'
                : 'Credentials remain in memory for this session',
            )}
          </p>
          {status.pendingRestore && (
            <p role="status">
              {t(
                'Restore pending. Restart Hikari to apply. New tasks are disabled until restart or cancellation.',
              )}
            </p>
          )}
        </>
      )}
      <div className="settings-actions">
        <Button
          disabled={busy}
          variant="outline"
          onClick={() => action(() => api().maintenance.backup())}
        >
          {t('Create data backup')}
        </Button>
        <Button
          disabled={busy || status?.pendingRestore}
          variant="outline"
          onClick={() => action(() => api().maintenance.restore())}
        >
          {t('Restore data backup')}
        </Button>
        {status?.pendingRestore && (
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => action(() => api().maintenance.cancelRestore())}
          >
            {t('Cancel pending restore')}
          </Button>
        )}
        <Button
          disabled={busy}
          variant="outline"
          onClick={() => action(() => api().maintenance.diagnostics())}
        >
          {t('Export diagnostics')}
        </Button>
        <Button
          disabled={busy || status?.pendingRestore}
          variant="outline"
          onClick={() => action(() => api().maintenance.prune())}
        >
          {t('Clean archived tasks older than 30 days')}
        </Button>
      </div>
      <p className="muted">
        {t(
          'Diagnostics include versions, counts and resource usage, without prompts, file contents or credentials.',
        )}
      </p>
    </section>
  );
}
