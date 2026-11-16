import { useI18n } from '../../shared/i18n/index';
import { useEffect, useState } from 'react';
import { Button } from '@hikari/ui';
import { api, perform, useStore } from '../../app/store';

export function SyncPanel() {
  const { t } = useI18n();

  const [form, setForm] = useState({
    url: 'http://127.0.0.1:4318',
    email: '',
    password: '',
    register: false,
  });
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setStatus(t('Working…'));
    await perform(action);
    if (useStore.getState().error) setStatus(t('Operation failed. See the error message below.'));
    setBusy(false);
  };
  const [account, setAccount] = useState('');
  useEffect(() => {
    let active = true;
    void api()
      .sync.status()
      .then((value) => {
        if (active) setAccount(value?.email ?? '');
      })
      .catch((error) => useStore.setState({ error: String(error) }));
    return () => {
      active = false;
    };
  }, []);
  const [status, setStatus] = useState('');
  const [remote, setRemote] = useState<
    { id: string; version: number; data: unknown; updatedAt: string }[]
  >([]);
  const taskId = useStore((s) => s.activeId);
  return (
    <section className="sync-panel">
      <h3>{t('Account & sync')}</h3>
      <p className="muted">
        {t(
          'Sync is optional. Upload sends this task’s prompt, selected file context and tool results to your server. API keys are excluded; review task content before uploading.',
        )}
      </p>
      {!account ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const user = await api().sync.connect(form);
              setAccount(user.email);
              setStatus(t('Signed in as {email}', { email: user.email }));
              setForm({ ...form, password: '' });
            });
          }}
        >
          {(['url', 'email', 'password'] as const).map((key) => (
            <label key={key}>
              {t(key)}
              <input
                aria-label={t(`Sync ${key}`)}
                type={key}
                autoComplete={
                  key === 'email'
                    ? 'username'
                    : key === 'password'
                      ? form.register
                        ? 'new-password'
                        : 'current-password'
                      : 'url'
                }
                value={form[key]}
                onChange={(event) => setForm({ ...form, [key]: event.target.value })}
              />
            </label>
          ))}
          <label>
            <input
              type="checkbox"
              checked={form.register}
              onChange={(event) => setForm({ ...form, register: event.target.checked })}
            />{' '}
            {t('Create an account')}
          </label>
          <Button type="submit" disabled={busy}>
            {busy ? t('Connecting…') : form.register ? t('Register & sign in') : t('Sign in')}
          </Button>
        </form>
      ) : (
        <>
          <p>{account}</p>
          <Button
            disabled={!taskId || busy}
            onClick={() =>
              void run(async () =>
                setStatus(
                  t('Uploaded revision {version}', { version: await api().sync.push(taskId!) }),
                ),
              )
            }
          >
            {t('Upload selected task')}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setRemote(await api().sync.pull());
                setStatus(t('Downloaded snapshots. Local task files were preserved.'));
              })
            }
          >
            {t('Download snapshots')}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api().sync.logout();
                setAccount('');
                setRemote([]);
                setStatus(t('Signed out.'));
              })
            }
          >
            {t('Sign out')}
          </Button>
        </>
      )}
      <p className="muted">{status}</p>
      {remote.map((record) => (
        <details key={record.id}>
          <summary>
            {t('Task {id} · revision {version}', {
              id: record.id.slice(0, 8),
              version: record.version,
            })}
          </summary>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const task = await api().sync.import(record.id);
                await useStore.getState().refresh();
                useStore.setState({ activeId: task.id });
                setStatus(t('Imported conversation. Local tools and approvals will start fresh.'));
              })
            }
          >
            {t('Continue locally')}
          </Button>
          <pre>{JSON.stringify(record.data, null, 2)}</pre>
        </details>
      ))}
    </section>
  );
}
