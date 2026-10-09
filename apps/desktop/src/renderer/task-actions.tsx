import { useEffect, useState } from 'react';
import { Button } from '@hikari/ui';
import type { Task } from '@hikari/agent-core';
import type { DesktopAPI } from '@hikari/shared';
import { api, perform, useStore } from './store';
import { useI18n } from './i18n';
export function TaskActions({ task }: { task: Task }) {
  const { t } = useI18n();
  const [title, setTitle] = useState(task.title);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setTitle(task.title);
    setConfirmDelete(false);
  }, [task.id, task.title]);
  const inactive = ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status);
  const action = (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void perform(async () => {
      await work();
      await useStore.getState().refresh();
    }).finally(() => setBusy(false));
  };
  return (
    <details className="task-actions">
      <summary>{t('Manage task')}</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          action(() => api().agent.rename(task.id, title));
        }}
      >
        <label>
          {t('Task name')}
          <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <Button type="submit" disabled={busy || !title.trim()}>
          {t('Rename')}
        </Button>
      </form>
      <div className="actions">
        <Button
          disabled={busy}
          variant="outline"
          onClick={() => action(() => api().agent.export(task.id))}
        >
          {t('Export conversation')}
        </Button>
        <Button
          disabled={busy || !inactive}
          variant="outline"
          onClick={() => action(() => api().agent.archive(task.id, !task.archived))}
        >
          {t(task.archived ? 'Unarchive' : 'Archive')}
        </Button>
        <Button
          disabled={busy || !inactive || !!task.worktree}
          variant="ghost"
          onClick={() => setConfirmDelete(true)}
        >
          {t('Delete task')}
        </Button>
      </div>
      {confirmDelete && (
        <div role="alert" className="actions">
          <p>{t('Delete this conversation permanently? Project files stay in place.')}</p>
          <Button
            disabled={busy}
            onClick={() =>
              action(async () => {
                await api().agent.remove(task.id);
                useStore.setState({ activeId: null });
              })
            }
          >
            {t('Delete task')}
          </Button>
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
            {t('Cancel')}
          </Button>
        </div>
      )}
    </details>
  );
}
export function WorktreeActions({ task }: { task: Task }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<Awaited<ReturnType<DesktopAPI['worktree']['preview']>>>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    setPreview(undefined);
    setMessage('');
  }, [task.id]);
  if ((!task.worktree && !task.worktreeArchive) || task.demo) return null;
  const inactive = ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status);
  const action = (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void perform(async () => {
      await work();
      await useStore.getState().refresh();
    }).finally(() => setBusy(false));
  };
  if (task.worktreeArchive)
    return (
      <details className="worktree-actions">
        <summary>{t('Archived worktree')}</summary>
        <p className="muted">{task.worktreeArchive}</p>
        <Button
          variant="outline"
          disabled={!inactive || busy}
          onClick={() => action(() => api().worktree.restore(task.id))}
        >
          {t('Restore worktree')}
        </Button>
      </details>
    );
  return (
    <details className="worktree-actions">
      <summary>{t('Isolated worktree')}</summary>
      <p className="muted">{task.worktree}</p>
      <p>
        {t(
          'Preview delivery before applying it to your original workspace. Conflicts and pre-existing edits block delivery. Archive saves tracked and untracked files before cleanup; ignored files are excluded.',
        )}
      </p>
      <div className="actions">
        <Button
          variant="outline"
          disabled={!inactive || busy}
          onClick={() =>
            action(async () => {
              setPreview(await api().worktree.preview(task.id));
              setMessage('');
            })
          }
        >
          {t('Preview delivery')}
        </Button>
        <Button
          disabled={!inactive || busy || !preview?.applicable}
          onClick={() =>
            action(async () => {
              await api().worktree.apply(task.id, preview!.id);
              setPreview(undefined);
              setMessage(t('Changes delivered to the original workspace'));
            })
          }
        >
          {t('Apply to workspace')}
        </Button>
        <Button
          variant="ghost"
          disabled={!inactive || busy}
          onClick={() =>
            action(async () => {
              const archive = await api().worktree.archive(task.id);
              setMessage(archive);
            })
          }
        >
          {t('Archive and clean up worktree')}
        </Button>
        <Button
          variant="ghost"
          disabled={!inactive || busy}
          onClick={() =>
            action(async () => {
              await api().worktree.undoDelivery(task.id);
              setMessage(t('Delivered changes undone'));
            })
          }
        >
          {t('Undo delivered changes')}
        </Button>
      </div>
      {preview && (
        <>
          <ul>
            {preview.files.map((file) => (
              <li key={file.path}>
                {file.path}
                {file.conflict ? ` · ${t(file.conflict)}` : ''}
              </li>
            ))}
          </ul>
          {preview.files.length > 20 && (
            <p>
              {t(
                'Delivery supports up to 20 text files. Use Git to deliver larger or binary changes.',
              )}
            </p>
          )}
          <pre className="delivery-diff">{preview.diff || t('No file changes yet.')}</pre>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
export function RecentWorkspaces() {
  const { t } = useI18n();
  const [recent, setRecent] = useState<{ root: string; name: string }[]>([]);
  const workspace = useStore((state) => state.workspace);
  useEffect(() => {
    void api()
      .workspace.recent()
      .then(setRecent)
      .catch(() => {});
  }, [workspace?.root]);
  if (!recent.length) return null;
  return (
    <label className="recent-workspaces">
      {t('Recent workspaces')}
      <select
        value=""
        onChange={(e) => {
          const root = e.target.value;
          if (root)
            void perform(async () =>
              useStore.setState({ workspace: await api().workspace.select(root), activeId: null }),
            );
        }}
      >
        <option value="">{t('Choose a workspace')}</option>
        {recent.map((item) => (
          <option key={item.root} value={item.root}>
            {item.name}
          </option>
        ))}
      </select>
    </label>
  );
}
