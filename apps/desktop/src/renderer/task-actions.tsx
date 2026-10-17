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
      {!task.demo && !task.chat && <TimelineActions task={task} />}
    </details>
  );
}
function TimelineActions({ task }: { task: Task }) {
  const { t, locale } = useI18n();
  const [entries, setEntries] = useState<Awaited<ReturnType<DesktopAPI['platform']['timeline']>>>(
    [],
  );
  const [selected, setSelected] = useState('');
  const [preview, setPreview] =
    useState<Awaited<ReturnType<DesktopAPI['platform']['previewRewind']>>>();
  const [mode, setMode] = useState<'code' | 'conversation' | 'both'>('conversation');
  const [busy, setBusy] = useState(false);
  const action = (work: () => Promise<unknown>) => {
    setBusy(true);
    void perform(work).finally(() => setBusy(false));
  };
  return (
    <details>
      <summary
        onClick={() => action(async () => setEntries(await api().platform.timeline(task.id)))}
      >
        {t('Conversation and code history')}
      </summary>
      <select
        aria-label={t('History checkpoint')}
        value={selected}
        onChange={(event) => {
          setSelected(event.target.value);
          setPreview(undefined);
        }}
      >
        <option value="">{t('Choose a checkpoint')}</option>
        {entries.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {new Date(entry.at).toLocaleString(locale)} ·{' '}
            {t(
              entry.label === 'before'
                ? 'Before execution'
                : entry.label === 'restored'
                  ? 'After restore'
                  : 'After execution',
            )}
          </option>
        ))}
      </select>
      <select
        aria-label={t('Restore mode')}
        value={mode}
        onChange={(event) => setMode(event.target.value as typeof mode)}
      >
        <option value="conversation">{t('Restore conversation')}</option>
        <option value="code">{t('Restore code')}</option>
        <option value="both">{t('Restore code and conversation')}</option>
      </select>
      <Button
        disabled={busy || !selected}
        variant="outline"
        onClick={() =>
          action(async () => setPreview(await api().platform.previewRewind(task.id, selected)))
        }
      >
        {t('Preview restore')}
      </Button>
      {preview && (
        <>
          <pre>{preview.diff || t('No code changes')}</pre>
          {preview.files
            .filter((file) => file.conflict)
            .map((file) => (
              <p key={file.path}>
                {file.path}: {file.conflict}
              </p>
            ))}
          <Button
            disabled={busy || (mode !== 'conversation' && !preview.applicable)}
            onClick={() =>
              action(async () => {
                const restored = await api().platform.rewind(task.id, selected, mode);
                await useStore.getState().refresh();
                if (restored) useStore.setState({ activeId: restored.id });
                setPreview(undefined);
              })
            }
          >
            {t('Restore checkpoint')}
          </Button>
        </>
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
