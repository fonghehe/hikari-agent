import { useEffect, useState } from 'react';
import { Button } from '@hikari/ui';
import type { DesktopAPI } from '@hikari/shared';
import { api, perform } from './store';
import { useI18n } from './i18n';

type Platform = Awaited<ReturnType<DesktopAPI['platform']['list']>>;
export function PlatformSettings({ workspaceRoot }: { workspaceRoot: string }) {
  const { t, locale } = useI18n();
  const [value, setValue] = useState<Platform>();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [once, setOnce] = useState('');
  const [isolated, setIsolated] = useState(true);
  const [notify, setNotify] = useState<'changes' | 'always' | 'failures'>('changes');
  const [network, setNetwork] = useState(false);
  const [registryURL, setRegistryURL] = useState('');
  const [catalogue, setCatalogue] = useState<
    Awaited<ReturnType<DesktopAPI['platform']['registry']>>
  >([]);
  const [hook, setHook] = useState({
    id: '',
    event: 'PostToolUse',
    tool: '',
    command: '',
    args: '',
  });
  const [lsp, setLsp] = useState({
    name: '',
    command: '',
    args: '',
    extensions: '.ts .tsx',
    languageId: 'typescript',
  });
  const refresh = async () => setValue(await api().platform.list(workspaceRoot));
  useEffect(() => {
    void perform(refresh);
  }, [workspaceRoot]);
  const action = (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void perform(async () => {
      await work();
      await refresh();
    }).finally(() => setBusy(false));
  };
  return (
    <section className="settings-section platform-settings">
      <h3>{t('Automation and integrations')}</h3>
      <details>
        <summary>{t('Scheduled tasks')}</summary>
        <p>{t('Keep Hikari running. Scheduled commands still follow your saved permissions.')}</p>
        {value?.automations.map((item) => (
          <article className="memory-entry" key={item.id}>
            <strong>{item.name}</strong>
            <p>{item.prompt}</p>
            <p>
              {item.enabled ? new Date(item.nextAt).toLocaleString(locale) : t('Paused')} ·{' '}
              {item.last ? t(`status.${item.last.status}`) : t('Not run')}
            </p>
            <div className="actions">
              <Button
                disabled={busy || item.running}
                onClick={() =>
                  action(() => api().platform.updateSchedule(item.id, !item.enabled, workspaceRoot))
                }
              >
                {t(item.enabled ? 'Pause' : 'Resume')}
              </Button>
              <Button
                disabled={busy || item.running}
                variant="ghost"
                onClick={() =>
                  action(() => api().platform.updateSchedule(item.id, null, workspaceRoot))
                }
              >
                {t('Remove')}
              </Button>
            </div>
          </article>
        ))}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            action(async () => {
              await api().platform.schedule(
                {
                  name,
                  prompt,
                  cadence: once
                    ? { kind: 'once', at: new Date(once).toISOString() }
                    : { kind: 'interval', minutes },
                  isolated,
                  notify,
                  options: { mode: 'execute', maxTokens: 100000, maxDurationMs: 600000 },
                },
                workspaceRoot,
              );
              setName('');
              setPrompt('');
            });
          }}
        >
          <label>
            {t('Task name')}
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t('Task instructions')}
            <textarea
              aria-label={t('Task instructions')}
              required
              maxLength={24000}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <label>
            {t('Repeat every (minutes)')}
            <input
              type="number"
              min={1}
              max={525600}
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
              disabled={!!once}
            />
          </label>
          <label>
            {t('Or run once at')}
            <input
              type="datetime-local"
              value={once}
              onChange={(event) => setOnce(event.target.value)}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={isolated}
              onChange={(event) => setIsolated(event.target.checked)}
            />
            {t('Isolate in a Git worktree')}
          </label>
          <label>
            {t('Notifications')}
            <select
              aria-label={t('Notifications')}
              value={notify}
              onChange={(event) => setNotify(event.target.value as typeof notify)}
            >
              <option value="changes">{t('Changes and failures')}</option>
              <option value="always">{t('Every run')}</option>
              <option value="failures">{t('Failures only')}</option>
            </select>
          </label>
          <Button type="submit" disabled={busy || !name.trim() || !prompt.trim()}>
            {t('Create schedule')}
          </Button>
        </form>
      </details>
      <details>
        <summary>{t('Plugins')}</summary>
        <label className="field-wide">
          {t('Plugin registry URL or file')}
          <input value={registryURL} onChange={(event) => setRegistryURL(event.target.value)} />
        </label>
        <Button
          disabled={busy || !registryURL.trim()}
          variant="outline"
          onClick={() =>
            action(async () =>
              setCatalogue(await api().platform.registry(registryURL, workspaceRoot)),
            )
          }
        >
          {t('Browse registry')}
        </Button>
        {catalogue.map((entry) => (
          <article className="memory-entry" key={entry.name + entry.version}>
            <strong>
              {entry.name} · {entry.version}
            </strong>
            <p>{entry.description}</p>
            <code>{entry.sha256}</code>
            <Button
              disabled={busy}
              onClick={() =>
                action(() =>
                  api().platform.installRegistry(
                    entry,
                    value?.plugins.some((plugin) => plugin.name === entry.name),
                    workspaceRoot,
                  ),
                )
              }
            >
              {t(
                value?.plugins.some((plugin) => plugin.name === entry.name) ? 'Update' : 'Install',
              )}
            </Button>
          </article>
        ))}
        <p>
          {t(
            'Install a reviewed plugin folder. Commands supplied by plugins still require approval.',
          )}
        </p>
        {value?.plugins.map((plugin) => (
          <article className="memory-entry" key={plugin.name}>
            <strong>
              {plugin.name} · {plugin.version}
            </strong>
            <p>{plugin.description}</p>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => action(() => api().platform.removePlugin(plugin.name, workspaceRoot))}
            >
              {t('Remove')}
            </Button>
          </article>
        ))}
        <div className="actions">
          <Button
            disabled={busy}
            onClick={() => action(() => api().platform.importPlugin(false, workspaceRoot))}
          >
            {t('Install plugin folder')}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => action(() => api().platform.importPlugin(true, workspaceRoot))}
          >
            {t('Update plugin folder')}
          </Button>
        </div>
      </details>
      <details>
        <summary>{t('Lifecycle hooks')}</summary>
        <p>
          {t('Hooks run approved commands on matching events. A failed hook blocks the operation.')}
        </p>
        {value?.hooks.map((entry) => (
          <article key={entry.id}>
            <code>
              {entry.id} · {entry.event} · {entry.command}
            </code>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                action(() =>
                  api().platform.configure(
                    'hooks',
                    value.hooks.filter((hook) => hook.id !== entry.id),
                    workspaceRoot,
                  ),
                )
              }
            >
              {t('Remove')}
            </Button>
          </article>
        ))}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            action(() =>
              api().platform.configure(
                'hooks',
                [
                  ...(value?.hooks ?? []),
                  {
                    ...hook,
                    tool: hook.tool || undefined,
                    args: hook.args.split('\n').filter(Boolean),
                  },
                ],
                workspaceRoot,
              ),
            );
          }}
        >
          <label>
            {t('Name')}
            <input
              required
              value={hook.id}
              pattern="[\w-]+"
              onChange={(event) => setHook({ ...hook, id: event.target.value })}
            />
          </label>
          <label>
            {t('Event')}
            <select
              aria-label={t('Event')}
              value={hook.event}
              onChange={(event) => setHook({ ...hook, event: event.target.value })}
            >
              {['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'].map((event) => (
                <option key={event} value={event}>
                  {t(`hook.${event}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Tool filter (optional)')}
            <input
              value={hook.tool}
              onChange={(event) => setHook({ ...hook, tool: event.target.value })}
            />
          </label>
          <label className="field-wide">
            {t('Command')}
            <input
              required
              value={hook.command}
              onChange={(event) => setHook({ ...hook, command: event.target.value })}
            />
          </label>
          <label>
            {t('Arguments, one per line')}
            <textarea
              aria-label={t('Arguments, one per line')}
              value={hook.args}
              onChange={(event) => setHook({ ...hook, args: event.target.value })}
            />
          </label>
          <Button type="submit" disabled={busy}>
            {t('Add hook')}
          </Button>
        </form>
      </details>
      <details>
        <summary>{t('Language servers')}</summary>
        <p>
          {t(
            'Install the language server first, then configure its executable and file extensions.',
          )}
        </p>
        {value?.lsp.map((entry) => (
          <article key={entry.name}>
            <code>
              {entry.name} · {entry.extensions.join(' ')}
            </code>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                action(() =>
                  api().platform.configure(
                    'lsp',
                    value.lsp.filter((server) => server.name !== entry.name),
                    workspaceRoot,
                  ),
                )
              }
            >
              {t('Remove')}
            </Button>
          </article>
        ))}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            action(() =>
              api().platform.configure(
                'lsp',
                [
                  ...(value?.lsp ?? []),
                  {
                    ...lsp,
                    extensions: lsp.extensions.split(/\s+/).filter(Boolean),
                    args: lsp.args.split('\n').filter(Boolean),
                  },
                ],
                workspaceRoot,
              ),
            );
          }}
        >
          <label>
            {t('Name')}
            <input
              required
              value={lsp.name}
              onChange={(event) => setLsp({ ...lsp, name: event.target.value })}
            />
          </label>
          <label className="field-wide">
            {t('Command')}
            <input
              required
              value={lsp.command}
              onChange={(event) => setLsp({ ...lsp, command: event.target.value })}
            />
          </label>
          <label>
            {t('Arguments, one per line')}
            <textarea
              aria-label={t('Arguments, one per line')}
              value={lsp.args}
              onChange={(event) => setLsp({ ...lsp, args: event.target.value })}
            />
          </label>
          <label>
            {t('File extensions')}
            <input
              required
              value={lsp.extensions}
              onChange={(event) => setLsp({ ...lsp, extensions: event.target.value })}
            />
          </label>
          <label>
            {t('Language ID')}
            <input
              required
              value={lsp.languageId}
              onChange={(event) => setLsp({ ...lsp, languageId: event.target.value })}
            />
          </label>
          <Button type="submit" disabled={busy}>
            {t('Add language server')}
          </Button>
        </form>
      </details>
      <details>
        <summary>{t('Remote control')}</summary>
        <p>
          {t(
            'The access token controls this project. Use HTTPS or an SSH tunnel when connecting from another device.',
          )}
        </p>
        {value?.remote ? (
          <>
            <p>
              <code>{value.remote.url}</code>
            </p>
            <div className="actions">
              <Button
                disabled={busy}
                onClick={() => action(() => api().clipboard.write(value.remote!.token))}
              >
                {t('Copy access token')}
              </Button>
              <Button
                disabled={busy}
                variant="outline"
                onClick={() => action(() => api().external.open(value.remote!.url))}
              >
                {t('Open remote panel')}
              </Button>
              <Button
                disabled={busy}
                variant="ghost"
                onClick={() => action(() => api().platform.remoteStop(workspaceRoot))}
              >
                {t('Stop remote control')}
              </Button>
            </div>
          </>
        ) : (
          <div className="remote-connection-controls">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={network}
                onChange={(event) => setNetwork(event.target.checked)}
              />
              {t('Listen on the local network')}
            </label>
            <Button
              disabled={busy}
              onClick={() =>
                action(() =>
                  api().platform.remoteStart(
                    network ? '0.0.0.0' : '127.0.0.1',
                    4319,
                    workspaceRoot,
                  ),
                )
              }
            >
              {t('Start remote control')}
            </Button>
          </div>
        )}
      </details>
    </section>
  );
}
