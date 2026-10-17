import { useState } from 'react';
import {
  Pencil,
  Pin,
  Eye,
  List,
  GitBranch,
  Share,
  Copy,
  PanelsTopLeft,
  ExternalLink,
  Archive,
  Trash2,
  Plus,
  Check,
} from 'lucide-react';
import type { Task } from '@hikari/agent-core';
import { Button } from '@hikari/ui';
import { ContextMenu } from './context-menu';
import { Dialog } from './dialog';
import { useI18n, localizedError } from './i18n';
import { api, perform, useStore } from './store';

export function ConversationMenu({
  menu,
  sections,
  close,
  select,
}: {
  menu: { task: Task; x: number; y: number } | null;
  sections: string[];
  close(): void;
  select(task: Task): void;
}) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<{
    task: Task;
    type: 'rename' | 'section' | 'share' | 'delete';
  } | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shared, setShared] = useState('');
  const work = (run: () => Promise<unknown>) =>
    void perform(async () => {
      await run();
      await useStore.getState().refresh();
    });
  const open = (task: Task, type: NonNullable<typeof dialog>['type']) => {
    setValue(type === 'rename' ? task.title : '');
    setShared('');
    setError('');
    setDialog({ task, type });
    if (type === 'share')
      void api()
        .agent.copy(task.id, 'conversation')
        .then(setShared)
        .catch((reason) => setError(localizedError(reason)));
  };
  const copy = (task: Task, format: Parameters<ReturnType<typeof api>['agent']['copy']>[1]) =>
    work(async () => {
      await api().clipboard.write(await api().agent.copy(task.id, format));
      useStore.setState({ notice: t('Copied to clipboard') });
    });
  const task = menu?.task;
  const inactive =
    task && ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status);
  const organize = (options: Parameters<ReturnType<typeof api>['agent']['organize']>[1]) =>
    work(() => api().agent.organize(task!.id, options));
  const submit = async () => {
    if (!dialog || busy) return;
    setBusy(true);
    setError('');
    try {
      if (dialog.type === 'rename') await api().agent.rename(dialog.task.id, value);
      if (dialog.type === 'section') {
        await api().sections.create(value.trim());
        await api().agent.organize(dialog.task.id, { section: value.trim(), pinned: false });
        useStore.setState((state) => ({ projectsRevision: state.projectsRevision + 1 }));
      }
      if (dialog.type === 'delete') {
        await api().agent.remove(dialog.task.id);
        if (useStore.getState().activeId === dialog.task.id) useStore.setState({ activeId: null });
      }
      await useStore.getState().refresh();
      setDialog(null);
    } catch (reason) {
      setError(localizedError(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {menu && task && (
        <ContextMenu
          label={t('Conversation actions')}
          x={menu.x}
          y={menu.y}
          close={close}
          items={[
            { id: 'rename', label: t('Rename'), icon: <Pencil />, run: () => open(task, 'rename') },
            {
              id: 'pin',
              label: t(task.navigation?.pinned ? 'Unpin' : 'Pin'),
              icon: <Pin />,
              run: () => organize({ pinned: !task.navigation?.pinned }),
            },
            {
              id: 'unread',
              label: t(task.navigation?.unread ? 'Mark as read' : 'Mark as unread'),
              icon: <Eye />,
              run: () => organize({ unread: !task.navigation?.unread }),
            },
            {
              id: 'section',
              label: t('Section'),
              icon: <List />,
              children: [
                {
                  id: 'default',
                  label: t('Default section'),
                  icon: !task.navigation?.section ? <Check /> : undefined,
                  run: () => organize({ section: null, pinned: false }),
                },
                ...sections.map((section) => ({
                  id: `section-${section}`,
                  label: section,
                  icon: section === task.navigation?.section ? <Check /> : undefined,
                  run: () => organize({ section, pinned: false }),
                })),
                null,
                {
                  id: 'new-section',
                  label: t('New section…'),
                  icon: <Plus />,
                  run: () => open(task, 'section'),
                },
              ],
            },
            null,
            {
              id: 'fork',
              label: t('Fork'),
              icon: <GitBranch />,
              disabled: !inactive || !!task.worktreeArchive,
              children: [
                ...([false, true] as const).map((isolated) => ({
                  id: `fork-${isolated}`,
                  label: t(isolated ? 'Fork into a new worktree' : 'Fork conversation'),
                  disabled: isolated && (!!task.demo || !!task.chat || !!task.worktree),
                  run: () =>
                    work(async () => {
                      const fork = await api().agent.fork(
                        task.id,
                        t('{name} (fork)', { name: task.title }).slice(0, 120),
                        isolated,
                      );
                      await useStore.getState().refresh();
                      select(fork);
                    }),
                })),
              ],
            },
            null,
            { id: 'share', label: t('Share'), icon: <Share />, run: () => open(task, 'share') },
            {
              id: 'copy',
              label: t('Copy'),
              icon: <Copy />,
              children: (
                [
                  ['title', 'Copy title'],
                  ['prompt', 'Copy prompt'],
                  ['answer', 'Copy response'],
                  ['conversation', 'Copy conversation'],
                  ['id', 'Copy task ID'],
                ] as const
              ).map(([format, label]) => ({
                id: format,
                label: t(label),
                run: () => copy(task, format),
              })),
            },
            null,
            {
              id: 'window',
              label: t('Open in new window'),
              icon: <PanelsTopLeft />,
              run: () => work(() => api().agent.openWindow(task.id)),
            },
            {
              id: 'open',
              label: t('Open with'),
              icon: <ExternalLink />,
              children: [
                { id: 'app', label: 'Hikari', run: () => select(task) },
                ...(['system', 'vscode'] as const).map((target) => ({
                  id: target,
                  label: t(target === 'system' ? 'System file manager' : 'VS Code'),
                  disabled: !!task.demo || !!task.chat || !!task.worktreeArchive,
                  run: () => work(() => api().agent.openExternal(task.id, target)),
                })),
              ],
            },
            null,
            {
              id: 'archive',
              label: t(task.archived ? 'Unarchive' : 'Archive'),
              icon: <Archive />,
              disabled: !inactive,
              run: () => work(() => api().agent.archive(task.id, !task.archived)),
            },
            {
              id: 'delete',
              label: t('Permanently delete'),
              icon: <Trash2 />,
              danger: true,
              disabled: !inactive || !!task.worktree,
              run: () => open(task, 'delete'),
            },
          ]}
        />
      )}
      {dialog && (
        <Dialog
          title={t(
            dialog.type === 'rename'
              ? 'Rename conversation'
              : dialog.type === 'section'
                ? 'New section…'
                : dialog.type === 'share'
                  ? 'Share conversation'
                  : 'Permanently delete?',
          )}
          close={() => {
            if (!busy) setDialog(null);
          }}
          className={dialog.type === 'share' ? 'share-dialog' : 'confirmation-dialog'}
        >
          {dialog.type === 'share' ? (
            <>
              <p>
                {t(
                  'Copy the conversation or export a file to share. Only conversation text is included in the copied content.',
                )}
              </p>
              <textarea aria-label={t('Conversation text')} readOnly value={shared} />
              <div className="actions">
                <Button disabled={!shared} onClick={() => copy(dialog.task, 'conversation')}>
                  {t('Copy conversation')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => work(() => api().agent.export(dialog.task.id))}
                >
                  {t('Export conversation')}
                </Button>
              </div>
              {error && <p role="alert">{error}</p>}
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              {dialog.type === 'delete' ? (
                <p>{t('Delete this conversation permanently? Project files stay in place.')}</p>
              ) : (
                <label>
                  {t(dialog.type === 'rename' ? 'Task name' : 'Section name')}
                  <input
                    data-autofocus
                    value={value}
                    maxLength={dialog.type === 'rename' ? 120 : 60}
                    required
                    onChange={(event) => setValue(event.target.value)}
                  />
                </label>
              )}
              {error && <p role="alert">{error}</p>}
              <div className="actions confirmation-actions">
                <Button
                  type="button"
                  data-autofocus={dialog.type === 'delete' ? true : undefined}
                  variant="outline"
                  disabled={busy}
                  onClick={() => setDialog(null)}
                >
                  {t('Cancel')}
                </Button>
                <Button
                  type="submit"
                  disabled={busy || (dialog.type !== 'delete' && !value.trim())}
                >
                  {t(dialog.type === 'delete' ? 'Permanently delete' : 'Save')}
                </Button>
              </div>
            </form>
          )}
        </Dialog>
      )}
    </>
  );
}
