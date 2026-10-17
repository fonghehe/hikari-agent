import { useState } from 'react';
import { Settings, Check, Archive, Plus, X } from 'lucide-react';
import { Button } from '@hikari/ui';
import { ContextMenu } from './context-menu';
import { Dialog } from './dialog';
import { api, perform, useStore } from './store';
import { useI18n, localizedError } from './i18n';

export function SectionMenu({
  menu,
  close,
}: {
  menu: {
    name: string;
    x: number;
    y: number;
    unread: boolean;
    hasTasks: boolean;
    active: boolean;
  } | null;
  close(): void;
}) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<{ type: 'edit' | 'create' | 'remove'; name: string } | null>(
    null,
  );
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => {
    await useStore.getState().refresh();
    useStore.setState((state) => ({ projectsRevision: state.projectsRevision + 1 }));
  };
  const open = (type: NonNullable<typeof dialog>['type']) => {
    setDialog({ type, name: menu!.name });
    setName(type === 'edit' ? menu!.name : '');
    setError('');
  };
  const action = (run: () => Promise<unknown>) =>
    void perform(async () => {
      await run();
      await refresh();
    });
  return (
    <>
      {menu && (
        <ContextMenu
          label={t('Section actions')}
          x={menu.x}
          y={menu.y}
          close={close}
          items={[
            { id: 'edit', label: t('Edit'), icon: <Settings />, run: () => open('edit') },
            null,
            {
              id: 'read',
              label: t('Mark all as read'),
              icon: <Check />,
              disabled: !menu.unread,
              run: () => action(() => api().sections.markRead(menu.name)),
            },
            {
              id: 'archive',
              label: t('Archive chats'),
              icon: <Archive />,
              disabled: !menu.hasTasks || menu.active,
              run: () => action(() => api().sections.archive(menu.name)),
            },
            null,
            { id: 'new', label: t('New section…'), icon: <Plus />, run: () => open('create') },
            { id: 'remove', label: t('Remove section'), icon: <X />, run: () => open('remove') },
          ]}
        />
      )}
      {dialog && (
        <Dialog
          title={t(
            dialog.type === 'edit'
              ? 'Edit section'
              : dialog.type === 'create'
                ? 'New section…'
                : 'Remove section?',
          )}
          close={() => {
            if (!busy) setDialog(null);
          }}
          className="confirmation-dialog"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError('');
              const run =
                dialog.type === 'edit'
                  ? api().sections.rename(dialog.name, name)
                  : dialog.type === 'create'
                    ? api().sections.create(name)
                    : api().sections.remove(dialog.name);
              void run
                .then(refresh)
                .then(() => setDialog(null))
                .catch((reason) => setError(localizedError(reason)))
                .finally(() => setBusy(false));
            }}
          >
            {dialog.type === 'remove' ? (
              <p>
                {t(
                  'Remove {name}? Projects and conversations return to their default sections. History and files are kept.',
                  { name: dialog.name },
                )}
              </p>
            ) : (
              <label>
                {t('Section name')}
                <input
                  data-autofocus
                  value={name}
                  required
                  maxLength={60}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            )}
            {error && <p role="alert">{error}</p>}
            <div className="actions confirmation-actions">
              <Button
                type="button"
                data-autofocus={dialog.type === 'remove' ? true : undefined}
                variant="outline"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={busy || (dialog.type !== 'remove' && !name.trim())}>
                {t(dialog.type === 'remove' ? 'Remove section' : 'Save')}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
