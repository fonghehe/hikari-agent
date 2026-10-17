import { useState } from 'react';
import type { WorkspaceProject } from '@hikari/shared';
import { Button } from '@hikari/ui';
import { Dialog } from './dialog';
import { api, useStore } from './store';
import { useI18n, localizedError } from './i18n';

export function ProjectRemovalDialog({
  project,
  close,
  removed,
}: {
  project: WorkspaceProject;
  close(): void;
  removed?(): void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog
      title={t('Remove project?')}
      close={() => {
        if (!busy) close();
      }}
      className="confirmation-dialog"
    >
      <p>{t('Remove {name} from the sidebar?', { name: project.name })}</p>
      <p className="muted">
        {t(
          'Removing a project keeps its files and conversation history. Add the same path again to reconnect them.',
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="actions confirmation-actions">
        <Button data-autofocus variant="outline" disabled={busy} onClick={close}>
          {t('Cancel')}
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            if (busy) return;
            setBusy(true);
            void api()
              .workspace.remove(project.root)
              .then(() => {
                useStore.setState((state) => ({
                  workspace:
                    state.workspace &&
                    (state.workspace.root === project.root ||
                      project.aliases?.includes(state.workspace.root))
                      ? null
                      : state.workspace,
                  projectsRevision: state.projectsRevision + 1,
                }));
                close();
                removed?.();
              })
              .catch((reason) => setError(localizedError(reason)))
              .finally(() => setBusy(false));
          }}
        >
          {t('Remove project')}
        </Button>
      </div>
    </Dialog>
  );
}
