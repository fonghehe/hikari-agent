import { Dialog } from './dialog';
import { useEffect, useState } from 'react';
import { Button } from '@hikari/ui';
import type { DesktopAPI, WorkspaceProject } from '@hikari/shared';
import { api, perform } from './store';
import { useI18n } from './i18n';
import { PlatformSettings } from './platform-settings';
import { DataSettings } from './data-settings';
function GrantDescription({ description }: { description: string }) {
  const { t } = useI18n();
  let value: unknown;
  try {
    value = JSON.parse(description);
  } catch {
    /* Older grants may be plain text. */
  }
  if (!Array.isArray(value) || typeof value[0] !== 'string' || typeof value[2] !== 'string')
    return <pre>{description}</pre>;
  const input = value[3] as { command?: unknown; args?: unknown } | undefined;
  const command = typeof input?.command === 'string' ? input.command : undefined;
  const args =
    Array.isArray(input?.args) && input.args.every((arg) => typeof arg === 'string')
      ? (input.args as string[])
      : [];
  return (
    <>
      <strong>{command ? t('Command execution') : value[2]}</strong>
      {command && (
        <code className="grant-command">
          {[command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(' ')}
        </code>
      )}
      <p className="muted grant-scope" title={value[0]}>
        {value[0]}
      </p>
      <details>
        <summary>{t('Permission details')}</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
    </>
  );
}

export function WorkspaceSettings({
  close,
  project,
}: {
  close(): void;
  project?: WorkspaceProject;
}) {
  const application = !project;
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<'memory' | 'extensions' | 'automation' | 'data' | 'updates'>(
    application ? 'data' : 'memory',
  );
  const tabs = application
    ? ([
        ['data', 'Data and diagnostics'],
        ['updates', 'Application updates'],
      ] as const)
    : ([
        ['memory', 'Memory'],
        ['extensions', 'Extensions'],
        ['automation', 'Automation and integrations'],
      ] as const);
  const workspace = project;
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
  const memoryScope = project?.root;
  const refresh = async () => {
    if (workspace) setExtensions(await api().extensions.list(workspace.root));
    if (memoryScope) setMemories(await api().agent.memories(memoryScope));
    if (application) {
      setUpdates(await api().updates.status());
      setGrants(await api().agent.grants());
    } else
      setGrants(
        (await api().agent.grants()).filter((grant) => {
          try {
            const value: unknown = JSON.parse(grant.description);
            return (
              Array.isArray(value) &&
              (value[0] === memoryScope || project?.aliases?.includes(value[0]))
            );
          } catch {
            return false;
          }
        }),
      );
  };
  useEffect(() => {
    void perform(refresh);
    if (!application) return;
    const timer = setInterval(() => {
      void api()
        .updates.status()
        .then(setUpdates)
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [memoryScope, application]);
  const action = (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void perform(async () => {
      await work();
      await refresh();
    }).finally(() => setBusy(false));
  };
  const permissions = (
    <section className="settings-section">
      <h3>{t('Persistent permissions')}</h3>
      {!grants.length && <p className="muted">{t('No persistent permissions')}</p>}
      {grants.map((grant) => (
        <article key={grant.id} className="memory-entry">
          <GrantDescription description={grant.description} />
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => action(() => api().agent.revokeGrant(grant.id))}
          >
            {t('Revoke')}
          </Button>
        </article>
      ))}
    </section>
  );
  return (
    <Dialog
      title={t(application ? 'Data & updates' : 'Memory & extensions')}
      close={close}
      className="workspace-settings"
    >
      <div
        className="settings-tabs"
        role="tablist"
        aria-label={t(application ? 'Data & updates' : 'Memory & extensions')}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const current = tabs.findIndex(([id]) => id === tab);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : (current + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
          setTab(tabs[next]![0]);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
        }}
      >
        {tabs.map(([id, label]) => (
          <button
            type="button"
            role="tab"
            key={id}
            id={`settings-tab-${id}`}
            aria-controls={`settings-panel-${id}`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {!application && (
        <>
          <p className="project-settings-context" title={project.root}>
            <strong>{project.name}</strong>
            <span>{project.root}</span>
          </p>
          <div
            className="settings-panel"
            role="tabpanel"
            id="settings-panel-memory"
            aria-labelledby="settings-tab-memory"
            hidden={tab !== 'memory'}
          >
            <section className="settings-section">
              <h3>{t('Project memory')}</h3>
              <p>
                {t(
                  'Local project facts are reference data. Review and remove outdated entries here.',
                )}
              </p>
              {!memories.length && <p className="muted">{t('No saved memory')}</p>}
              {memories.map((entry) => (
                <article key={entry.id} className="memory-entry">
                  <strong>{entry.title}</strong>
                  <p>{entry.content}</p>
                  <small>{new Date(entry.updatedAt).toLocaleString(locale)}</small>
                  {entry.source && (
                    <p className="muted">
                      {t('Memory source')}: {entry.source}
                    </p>
                  )}
                  {entry.expiresAt && (
                    <p className="muted">
                      {t('Expires at')}: {new Date(entry.expiresAt).toLocaleString(locale)}
                    </p>
                  )}
                  <div className="actions">
                    <Button
                      disabled={busy}
                      variant="ghost"
                      onClick={() => setEditing({ ...entry })}
                    >
                      {t('Edit memory')}
                    </Button>
                    <Button
                      disabled={busy}
                      variant="ghost"
                      onClick={() => action(() => api().agent.forget(memoryScope!, entry.id))}
                    >
                      {t('Forget')}
                    </Button>
                  </div>
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
                      aria-label={t('Memory content')}
                      value={editing.content}
                      maxLength={4000}
                      onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                    />
                  </label>
                  <label>
                    {t('Memory source')}
                    <input
                      value={editing.source ?? ''}
                      onChange={(e) =>
                        setEditing({ ...editing, source: e.target.value || undefined })
                      }
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
                          expiresAt: e.target.value
                            ? new Date(e.target.value).toISOString()
                            : undefined,
                        })
                      }
                    />
                  </label>
                  <div className="actions">
                    <Button type="submit" disabled={busy}>
                      {t('Save')}
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setEditing(undefined)}>
                      {t('Cancel editing')}
                    </Button>
                  </div>
                </form>
              )}
            </section>
            {permissions}
          </div>
          <div
            className="settings-panel"
            role="tabpanel"
            id="settings-panel-extensions"
            aria-labelledby="settings-tab-extensions"
            hidden={tab !== 'extensions'}
          >
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
                      onClick={() =>
                        action(() => api().extensions.server(key, null, project!.root))
                      }
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
                        project!.root,
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
                  <label>
                    {t('Transport')}
                    <select
                      aria-label={t('Transport')}
                      value={transport}
                      onChange={(e) => setTransport(e.target.value as typeof transport)}
                    >
                      <option value="http">HTTP</option>
                      <option value="stdio">{t('Local process')}</option>
                    </select>
                  </label>
                  {transport === 'http' ? (
                    <>
                      <label className="field-wide">
                        {t('Server URL')}
                        <input
                          required
                          type="url"
                          value={url}
                          onChange={(e) => setUrl(e.target.value)}
                        />
                      </label>
                      <label className="field-wide">
                        {t('Authorization token (optional)')}
                        <input
                          type="password"
                          autoComplete="off"
                          placeholder={t('Authorization token (optional)')}
                          aria-label={t('Authorization token (optional)')}
                          value={token}
                          onChange={(e) => setToken(e.target.value)}
                        />
                      </label>
                    </>
                  ) : (
                    <>
                      <label className="field-wide">
                        {t('Executable')}
                        <input
                          required
                          value={command}
                          onChange={(e) => setCommand(e.target.value)}
                        />
                      </label>
                      <label>
                        {t('Arguments (one per line)')}
                        <textarea
                          aria-label={t('Arguments (one per line)')}
                          value={args}
                          onChange={(e) => setArgs(e.target.value)}
                        />
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
                      onClick={() =>
                        action(() => api().extensions.removeSkill(skill.directory, project!.root))
                      }
                    >
                      {t('Remove')}
                    </Button>
                  </article>
                ))}
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => action(() => api().extensions.importSkill(project!.root))}
                >
                  {t('Import skill folder')}
                </Button>
              </>
            )}
          </div>
          <div
            className="settings-panel"
            role="tabpanel"
            id="settings-panel-automation"
            aria-labelledby="settings-tab-automation"
            hidden={tab !== 'automation'}
          >
            <PlatformSettings workspaceRoot={project.root} />
            {!workspace && (
              <p className="muted">{t('Open a workspace to manage its extensions')}</p>
            )}
          </div>
        </>
      )}
      {application && (
        <>
          <div
            className="settings-panel"
            role="tabpanel"
            id="settings-panel-data"
            aria-labelledby="settings-tab-data"
            hidden={tab !== 'data'}
          >
            <DataSettings />
            {permissions}
          </div>
          <div
            className="settings-panel"
            role="tabpanel"
            id="settings-panel-updates"
            aria-labelledby="settings-tab-updates"
            hidden={tab !== 'updates'}
          >
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
          </div>
        </>
      )}
    </Dialog>
  );
}
