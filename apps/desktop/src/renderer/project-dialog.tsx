import { useId, useState } from 'react';
import { Folder, FolderPlus, ChevronDown, X, File, TextCursorInput } from 'lucide-react';
import type { WorkspaceProject } from '@hikari/shared';
import { Button } from '@hikari/ui';
import { Dialog } from './dialog';
import { ProjectRemovalDialog } from './project-removal-dialog';
import { api, useStore } from './store';
import { useI18n, localizedError } from './i18n';
import './project-dialog.css';

export function ProjectDialog({
  project,
  close,
  created,
}: {
  project?: WorkspaceProject;
  close(): void;
  created(): void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const [name, setName] = useState(project?.name ?? '');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [manualPath, setManualPath] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState('');
  const changed = () =>
    useStore.setState((state) => ({ projectsRevision: state.projectsRevision + 1 }));
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (project) {
        const updated = await api().workspace.rename(project.root, name);
        useStore.setState((state) => ({
          workspace:
            state.workspace?.root === updated.root
              ? { ...state.workspace, name: updated.name }
              : state.workspace,
        }));
        changed();
      } else {
        if (!(await useStore.getState().addProject(path, name.trim() || undefined))) {
          setError(useStore.getState().error);
          return;
        }
        created();
      }
      close();
    } catch (reason) {
      setError(localizedError(reason));
    } finally {
      setBusy(false);
    }
  };
  const pick = async (kind: 'directory' | 'file') => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const selected = await api().workspace.pick(kind);
      if (selected) {
        setPath(selected);
        setManualPath(false);
      }
    } catch (reason) {
      setError(localizedError(reason));
    } finally {
      setBusy(false);
    }
  };
  if (confirmRemove && project)
    return (
      <ProjectRemovalDialog
        project={project}
        close={() => setConfirmRemove(false)}
        removed={close}
      />
    );
  const actions = (
    <div className="actions project-dialog-actions">
      {!project && (
        <Button type="button" variant="ghost" disabled={busy} onClick={close}>
          {t('Cancel')}
        </Button>
      )}
      <Button
        form={formId}
        type="submit"
        disabled={busy || (project ? !name.trim() : !path.trim())}
      >
        {t(busy ? 'Saving…' : project ? 'Save project' : 'Create project')}
      </Button>
      {project && (
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => setConfirmRemove(true)}
        >
          {t('Remove project')}
        </Button>
      )}
    </div>
  );
  return (
    <Dialog
      title={t(project ? 'Edit project' : 'Create project')}
      close={() => {
        if (!busy) close();
      }}
      className={`project-dialog ${project ? '' : 'project-create-dialog'}`}
      footer={project ? undefined : actions}
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className={project ? undefined : 'project-name-field'}>
          {project ? (
            t('Project name')
          ) : (
            <span className="project-name-icon">
              <Folder size={20} />
            </span>
          )}
          <input
            data-autofocus
            aria-label={t('Project name')}
            placeholder={t('Project name')}
            value={name}
            maxLength={100}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            required={!!project}
          />
        </label>
        {project ? (
          <p className="project-path" title={project.root}>
            {project.root}
          </p>
        ) : (
          <section className="project-source" aria-label={t('Source folder')}>
            <h3>{t('Source folder')}</h3>
            <div className="project-source-card">
              <details className="project-source-options">
                <summary aria-label={t('Source options')}>
                  {t('Add a folder on this computer')} <ChevronDown size={16} />
                </summary>
                <div className="project-source-menu">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(event) => {
                      event.currentTarget.closest('details')?.removeAttribute('open');
                      void pick('directory');
                    }}
                  >
                    <Folder size={16} />
                    {t('Choose folder')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(event) => {
                      event.currentTarget.closest('details')?.removeAttribute('open');
                      void pick('file');
                    }}
                  >
                    <File size={16} />
                    {t('Choose file')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(event) => {
                      event.currentTarget.closest('details')?.removeAttribute('open');
                      setManualPath(true);
                    }}
                  >
                    <TextCursorInput size={16} />
                    {t('Enter a path')}
                  </button>
                </div>
              </details>
              {manualPath ? (
                <label className="project-source-path">
                  {t('File or folder path')}
                  <input
                    aria-label={t('File or folder path')}
                    value={path}
                    placeholder={t('Enter an absolute path')}
                    disabled={busy}
                    onChange={(event) => setPath(event.target.value)}
                  />
                  <small className="muted">
                    {t('Files use their containing folder as the project.')}
                  </small>
                </label>
              ) : path ? (
                <div className="project-source-selected">
                  <Folder size={22} />
                  <span title={path}>{path}</span>
                  <button
                    type="button"
                    className="dialog-close"
                    aria-label={t('Remove source folder')}
                    disabled={busy}
                    onClick={() => setPath('')}
                  >
                    <X size={16} />
                  </button>
                </div>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                className="project-source-add"
                disabled={busy}
                onClick={() => void pick('directory')}
              >
                <FolderPlus size={20} />
                {path ? t('Change folder') : t('Add folder')}
              </Button>
            </div>
          </section>
        )}
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {project && actions}
        {project && (
          <p className="muted">
            {t(
              'Removing a project keeps its files and conversation history. Add the same path again to reconnect them.',
            )}
          </p>
        )}
      </form>
    </Dialog>
  );
}
