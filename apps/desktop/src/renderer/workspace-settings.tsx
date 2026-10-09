import { useEffect, useState } from 'react';
import { Button } from '@hikari/ui';
import type { DesktopAPI } from '@hikari/shared';
import { api, perform, useStore } from './store';
import { useI18n } from './i18n';
export function WorkspaceSettings({ close, scope }: { close(): void; scope?: string }) {
  const { t } = useI18n();
  const workspace = useStore((state) => state.workspace);
  const [extensions, setExtensions] =
    useState<Awaited<ReturnType<DesktopAPI['extensions']['list']>>>();
  const [memories, setMemories] = useState<Awaited<ReturnType<DesktopAPI['agent']['memories']>>>(
    [],
  );
  const [updates, setUpdates] = useState<Awaited<ReturnType<DesktopAPI['updates']['status']>>>();
  const [grants, setGrants] = useState<Awaited<ReturnType<DesktopAPI['agent']['grants']>>>([]);
  const [editing, setEditing] = useState<{
    id: string;
    title: string;
    content: string;
    source?: string;
    expiresAt?: string;
  }>();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'http' | 'stdio'>('http');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [busy, setBusy] = useState(false);
  const memoryScope = scope ?? workspace?.root;
  const refresh = async () => {
    if (workspace) setExtensions(await api().extensions.list());
    if (memoryScope) setMemories(await api().agent.memories(memoryScope));
    setUpdates(await api().updates.status());
    setGrants(await api().agent.grants());
  };
  useEffect(() => {
    void perform(refresh);
    const timer = setInterval(() => {
      void api()
        .updates.status()
        .then(setUpdates)
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [memoryScope, workspace?.root]);
  const action = (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void perform(async () => {
      await work();
      await refresh();
    }).finally(() => setBusy(false));
  };
  return (
    <div className="modal-backdrop">
      <section
        className="modal workspace-settings"
        role="dialog"
        aria-modal="true"
        aria-label={t('Workspace settings')}
      >
        <div className="progress-heading">
          <h2>{t('Workspace settings')}</h2>
          <Button variant="ghost" onClick={close}>
            {t('Close')}
          </Button>
        </div>
        <h3>{t('Project memory')}</h3>
        <p>
          {t('Local project facts are reference data. Review and remove outdated entries here.')}
        </p>
        {!memories.length && <p className="muted">{t('No saved memory')}</p>}
        {memories.map((entry) => (
          <article key={entry.id} className="memory-entry">
            <strong>{entry.title}</strong>
            <p>{entry.content}</p>
            <small>{new Date(entry.updatedAt).toLocaleString()}</small>
            {entry.source && (
              <p className="muted">
                {t('Memory source')}: {entry.source}
              </p>
            )}
            {entry.expiresAt && (
              <p className="muted">
                {t('Expires at')}: {new Date(entry.expiresAt).toLocaleString()}
              </p>
            )}
            <Button disabled={busy} variant="ghost" onClick={() => setEditing({ ...entry })}>
              {t('Edit memory')}
            </Button>
            <Button
              disabled={busy}
              variant="ghost"
              onClick={() => action(() => api().agent.forget(memoryScope!, entry.id))}
            >
              {t('Forget')}
            </Button>
          </article>
        ))}
        {editing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              action(async () => {
                await api().agent.editMemory(memoryScope!, editing);
                setEditing(undefined);
              });
            }}
          >
            <label>
              {t('Title')}
              <input
                value={editing.title}
                maxLength={150}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              />
            </label>
            <label>
              {t('Memory content')}
              <textarea
                value={editing.content}
                maxLength={4000}
                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              />
            </label>
            <label>
              {t('Memory source')}
              <input
                value={editing.source ?? ''}
                onChange={(e) => setEditing({ ...editing, source: e.target.value || undefined })}
              />
            </label>
            <label>
              {t('Expires at')}
              <input
                type="datetime-local"
                value={
                  editing.expiresAt
                    ? new Date(
                        Date.parse(editing.expiresAt) -
                          new Date(editing.expiresAt).getTimezoneOffset() * 60000,
                      )
                        .toISOString()
                        .slice(0, 16)
                    : ''
                }
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    expiresAt: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                  })
                }
              />
            </label>
            <div className="actions">
              <Button type="submit" disabled={busy}>
                {t('Save')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(undefined)}>
                {t('Cancel')}
              </Button>
            </div>
          </form>
        )}
        <h3>{t('Persistent permissions')}</h3>
        {!grants.length && <p className="muted">{t('No persistent permissions')}</p>}
        {grants.map((grant) => (
          <article key={grant.id} className="memory-entry">
            <pre>{grant.description}</pre>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => action(() => api().agent.revokeGrant(grant.id))}
            >
              {t('Revoke')}
            </Button>
          </article>
        ))}
        <h3>{t('MCP servers')}</h3>
        <p>
          {t(
            'Installed servers start only after an approved connection request. Changes apply to new tasks.',
          )}
        </p>
        {!workspace ? (
          <p>{t('Open a workspace to manage its extensions')}</p>
        ) : (
          <>
            {Object.entries(extensions?.mcp ?? {}).map(([key, config]) => (
              <article className="memory-entry" key={key}>
                <strong>{key}</strong>
                <p>
                  {config.transport === 'http'
                    ? config.url
                    : `${config.command} ${config.args.join(' ')}`}
                </p>
                <Button
                  disabled={busy}
                  variant="ghost"
                  onClick={() => action(() => api().extensions.server(key, null))}
                >
                  {t('Remove')}
                </Button>
              </article>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action(async () => {
                  await api().extensions.server(
                    name,
                    transport === 'http'
                      ? { transport, url, authToken: token }
                      : { transport, command, args: args.split('\n').filter(Boolean) },
                  );
                  setName('');
                  setUrl('');
                  setToken('');
                  setCommand('');
                  setArgs('');
                });
              }}
            >
              <label>
                {t('Server name')}
                <input
                  required
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <select
                value={transport}
                onChange={(e) => setTransport(e.target.value as typeof transport)}
              >
                <option value="http">HTTP</option>
                <option value="stdio">stdio</option>
              </select>
              {transport === 'http' ? (
                <label>
                  {t('Server URL')}
                  <input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={t('Authorization token (optional)')}
                    aria-label={t('Authorization token (optional)')}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </label>
              ) : (
                <>
                  <label>
                    {t('Executable')}
                    <input required value={command} onChange={(e) => setCommand(e.target.value)} />
                  </label>
                  <label>
                    {t('Arguments (one per line)')}
                    <textarea value={args} onChange={(e) => setArgs(e.target.value)} />
                  </label>
                </>
              )}
              <Button type="submit" disabled={busy}>
                {t('Save server')}
              </Button>
            </form>
            <h3>{t('Skills')}</h3>
            {extensions?.skills.map((skill) => (
              <article className="memory-entry" key={skill.directory}>
                <strong>{skill.name}</strong>
                <p>{skill.description}</p>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => action(() => api().extensions.removeSkill(skill.directory))}
                >
                  {t('Remove')}
                </Button>
              </article>
            ))}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => action(() => api().extensions.importSkill())}
            >
              {t('Import skill folder')}
            </Button>
          </>
        )}
        <h3>{t('Application updates')}</h3>
        <p>
          {t('Version')} {updates?.version} · {t(`update.${updates?.state ?? 'idle'}`)}{' '}
          {updates?.message}
        </p>
        {updates?.supported ? (
          <div className="actions">
            <Button
              disabled={busy || ['checking', 'downloading'].includes(updates.state)}
              onClick={() => action(() => api().updates.check())}
            >
              {t('Check for updates')}
            </Button>
            <Button
              disabled={busy || updates.state !== 'available'}
              onClick={() => action(() => api().updates.download())}
            >
              {t('Download update')}
            </Button>
            <Button
              disabled={busy || updates.state !== 'ready'}
              onClick={() => action(() => api().updates.install())}
            >
              {t('Restart and install')}
            </Button>
          </div>
        ) : (
          <p className="muted">
            {t(
              'This build has no release update feed. Install an official release to enable updates.',
            )}
          </p>
        )}
      </section>
    </div>
  );
}
