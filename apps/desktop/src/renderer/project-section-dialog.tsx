import { useState } from 'react';
import type { WorkspaceProject } from '@hikari/shared';
import { Button } from '@hikari/ui';
import { Dialog } from './dialog';
import { api, useStore } from './store';
import { useI18n, localizedError } from './i18n';

export function ProjectSectionDialog({
  project,
  close,
}: {
  project: WorkspaceProject;
  close(): void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog
      title={t('New section…')}
      close={() => {
        if (!busy) close();
      }}
      className="project-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !name.trim()) return;
          setBusy(true);
          void api()
            .sections.create(name.trim())
            .then(() => api().workspace.organize(project.root, { section: name.trim() }))
            .then(() => {
              useStore.setState((state) => ({ projectsRevision: state.projectsRevision + 1 }));
              close();
            })
            .catch((reason) => setError(localizedError(reason)))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          {t('Section name')}
          <input
            aria-label={t('Section name')}
            value={name}
            maxLength={60}
            required
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <Button type="submit" disabled={busy || !name.trim()}>
          {t('Move project')}
        </Button>
      </form>
    </Dialog>
  );
}
