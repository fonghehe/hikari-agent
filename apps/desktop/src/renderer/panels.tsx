import { useI18n } from './i18n';
import { usePreferences } from './preferences';
import { useEffect, useRef, useState } from 'react';
import type { Terminal as XTerminal } from '@xterm/xterm';
import { Button } from '@hikari/ui';
import { api, perform, useStore } from './store';
import { providerCatalog, type ModelConfig, type ChangeDTO } from '@hikari/shared';
export function ModelSettings({ close }: { close: () => void }) {
  const { t } = useI18n();

  const [profiles, setProfiles] = useState<ModelConfig[]>([]);
  const [connection, setConnection] = useState('');
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);
  const connect = async (value: ModelConfig) => {
    if (saving) return;
    setSaving(true);
    await perform(async () => {
      await api().agent.configure(value);
      useStore.setState({
        configured: value.provider !== 'demo',
        activeId: null,
        notice:
          value.provider === 'demo'
            ? t('Demo mode enabled · no model or workspace required.')
            : t('Model connected. Start a new task in your workspace.'),
      });
      close();
    });
    setSaving(false);
  };
  const [config, setConfig] = useState<ModelConfig>({
    provider: 'compatible',
    model: '',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
  });
  useEffect(() => {
    let alive = true;
    void api()
      .agent.profiles()
      .then((value) => {
        if (alive) setProfiles(value);
      })
      .catch(() => {});
    void api()
      .agent.settings()
      .then((value) => {
        if (alive && value && value.provider !== 'demo') setConfig(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('Model settings')}
        onSubmit={(event) => {
          event.preventDefault();
          void connect({ ...config, baseUrl: config.baseUrl || undefined });
        }}
      >
        <h2>{t('Connect your model')}</h2>
        <label>
          {t('Saved model profiles')}
          <select
            value={config.profileId ?? ''}
            onChange={(e) => {
              const profile = profiles.find((item) => item.profileId === e.target.value);
              if (profile) {
                setConfig(profile);
                setModels([]);
                setConnection('');
              } else setConfig({ provider: 'compatible', model: '', baseUrl: '', apiKey: '' });
            }}
          >
            <option value="">{t('New model profile')}</option>
            {profiles.map((profile) => (
              <option key={profile.profileId} value={profile.profileId}>
                {profile.label ?? `${providerCatalog[profile.provider].name} · ${profile.model}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Profile name')}
          <input
            value={config.label ?? ''}
            onChange={(e) => setConfig({ ...config, label: e.target.value || undefined })}
          />
        </label>
        {config.profileId && (
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={() =>
              void perform(async () => {
                await api().agent.removeProfile(config.profileId!);
                setProfiles(await api().agent.profiles());
                setConfig({ provider: 'compatible', model: '', apiKey: '', baseUrl: '' });
              })
            }
          >
            {t('Remove profile')}
          </Button>
        )}
        <p>
          {t(
            'Want to try without an API key? Use offline Q&A and the sample project. Real model failures never switch to simulated answers.',
          )}
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={() => void connect({ provider: 'demo', model: 'offline-demo', apiKey: '' })}
        >
          {t('Use offline demo')}
        </Button>
        <p>
          {t(
            'Credentials are encrypted with the OS keychain when available; otherwise they stay in memory.',
          )}
        </p>
        <label>
          {t('Provider')}
          <select
            value={config.provider}
            onChange={(e) => {
              const provider = e.target.value as ModelConfig['provider'];
              setModels([]);
              setConnection('');
              setConfig({
                ...config,
                profileId: undefined,
                provider,
                baseUrl: providerCatalog[provider].baseUrl,
                model: '',
                apiKey: '',
                tokenParameter: provider === 'openai' ? 'max_completion_tokens' : 'max_tokens',
              });
            }}
          >
            {Object.entries(providerCatalog)
              .filter(([id]) => id !== 'demo')
              .map(([id, preset]) => (
                <option key={id} value={id}>
                  {preset.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          {t('Model')}
          <input
            required
            list="provider-models"
            placeholder={t('Your provider’s model ID')}
            value={config.model}
            onChange={(e) => setConfig({ ...config, model: e.target.value })}
          />
        </label>
        <datalist id="provider-models">
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
        <Button
          type="button"
          variant="outline"
          disabled={discovering || saving}
          onClick={() => {
            setDiscovering(true);
            void perform(async () =>
              setModels(
                await api().agent.models({
                  ...config,
                  model: config.model || 'discovery',
                  baseUrl: config.baseUrl || undefined,
                }),
              ),
            ).finally(() => setDiscovering(false));
          }}
        >
          {discovering ? t('Checking…') : t('Load available models')}
        </Button>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.supportsTools !== false}
            onChange={(e) => setConfig({ ...config, supportsTools: e.target.checked })}
          />
          {t('This model supports tool calls')}
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.streaming !== false}
            onChange={(e) => setConfig({ ...config, streaming: e.target.checked })}
          />
          {t('Stream responses')}
        </label>
        <label>
          {t('Base URL')}
          <input
            value={config.baseUrl}
            onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })}
          />
        </label>
        <label>
          {t('API key')}
          <input
            type="password"
            autoComplete="off"
            value={config.apiKey}
            onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.supportsVision ?? false}
            onChange={(event) => setConfig({ ...config, supportsVision: event.target.checked })}
          />{' '}
          {t('This model accepts images')}
        </label>
        <details>
          <summary>{t('Semantic retrieval')}</summary>
          <p>
            {t(
              'Optional embeddings send searched attachment text and saved project memory to the selected endpoint. Keyword search works without them. Embedding charges are separate from the chat budget.',
            )}
          </p>
          <label>
            <input
              type="checkbox"
              checked={config.embeddings?.enabled ?? false}
              onChange={(e) =>
                setConfig({
                  ...config,
                  embeddings: {
                    enabled: e.target.checked,
                    model: config.embeddings?.model ?? 'text-embedding-3-small',
                    baseUrl: config.embeddings?.baseUrl ?? 'https://api.openai.com/v1',
                    apiKey: config.embeddings?.apiKey ?? '',
                  },
                })
              }
            />
            {t('Enable semantic retrieval')}
          </label>
          {config.embeddings && (
            <>
              <label>
                {t('Embedding model')}
                <input
                  value={config.embeddings.model}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      embeddings: { ...config.embeddings!, model: e.target.value },
                    })
                  }
                />
              </label>
              <label>
                {t('Embedding endpoint')}
                <input
                  type="url"
                  value={config.embeddings.baseUrl}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      embeddings: { ...config.embeddings!, baseUrl: e.target.value },
                    })
                  }
                />
              </label>
              <label>
                {t('Embedding API key')}
                <input
                  type="password"
                  value={config.embeddings.apiKey}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      embeddings: { ...config.embeddings!, apiKey: e.target.value },
                    })
                  }
                />
              </label>
            </>
          )}
        </details>
        <details>
          <summary>{t('Usage and compatibility')}</summary>
          <label>
            {t('Search service URL (SearXNG)')}
            <input
              type="url"
              placeholder="https://your-search.example/search"
              value={config.searchUrl ?? ''}
              onChange={(e) => setConfig({ ...config, searchUrl: e.target.value || undefined })}
            />
          </label>
          <label>
            {t('Input price / million tokens (USD)')}
            <input
              type="number"
              min={0}
              step={0.01}
              value={config.inputPerMillion ?? ''}
              onChange={(e) =>
                setConfig({
                  ...config,
                  inputPerMillion: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </label>
          <label>
            {t('Output price / million tokens (USD)')}
            <input
              type="number"
              min={0}
              step={0.01}
              value={config.outputPerMillion ?? ''}
              onChange={(e) =>
                setConfig({
                  ...config,
                  outputPerMillion: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </label>
          <label>
            {t('Context window (tokens)')}
            <input
              type="number"
              min={8192}
              max={2000000}
              value={config.contextWindow ?? 64000}
              onChange={(e) => setConfig({ ...config, contextWindow: Number(e.target.value) })}
            />
          </label>
          <label>
            {t('Reasoning effort')}
            <select
              value={config.reasoningEffort ?? ''}
              onChange={(e) =>
                setConfig({
                  ...config,
                  reasoningEffort: (e.target.value || undefined) as ModelConfig['reasoningEffort'],
                })
              }
            >
              <option value="">{t('Provider default')}</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
          <label>
            {t('Maximum output tokens')}
            <input
              type="number"
              min={256}
              max={65536}
              value={config.maxOutputTokens ?? 4096}
              onChange={(e) => setConfig({ ...config, maxOutputTokens: Number(e.target.value) })}
            />
          </label>
          <label>
            {t('Retry attempts')}
            <input
              type="number"
              min={1}
              max={5}
              value={config.retries ?? 3}
              onChange={(e) => setConfig({ ...config, retries: Number(e.target.value) })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={config.includeUsage ?? true}
              onChange={(e) => setConfig({ ...config, includeUsage: e.target.checked })}
            />
            {t('Request streaming usage')}
          </label>
          <label>
            {t('Output limit parameter')}
            <select
              value={
                config.tokenParameter ??
                (config.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens')
              }
              onChange={(e) =>
                setConfig({
                  ...config,
                  tokenParameter: e.target.value as ModelConfig['tokenParameter'],
                })
              }
            >
              <option value="max_tokens">max_tokens</option>
              <option value="max_completion_tokens">max_completion_tokens</option>
            </select>
          </label>
        </details>
        <Button
          type="button"
          variant="outline"
          disabled={testing || saving || !config.model}
          onClick={() => {
            setTesting(true);
            void perform(async () => {
              const result = await api().agent.test({
                ...config,
                baseUrl: config.baseUrl || undefined,
              });
              setConnection(
                t(
                  result.tools
                    ? 'Connection and tool calls verified'
                    : 'Connection verified; tool support was not confirmed',
                ),
              );
            }).finally(() => setTesting(false));
          }}
        >
          {testing ? t('Checking…') : t('Test connection (uses tokens)')}
        </Button>
        {connection && <p role="status">{connection}</p>}
        <div className="actions">
          <Button type="button" variant="ghost" onClick={close}>
            {t('Cancel')}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? t('Saving…') : t('Connect model')}
          </Button>
        </div>
      </form>
    </div>
  );
}
export function CodePanel({ content, original }: { content: string; original?: string }) {
  const theme = usePreferences((state) => state.resolvedTheme);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void import('./monaco')
      .then(({ mountEditor }) => {
        if (!disposed && ref.current) cleanup = mountEditor(ref.current, content, original, theme);
      })
      .catch((error) => useStore.setState({ error: String(error) }));
    return () => {
      disposed = true;
      cleanup();
    };
  }, [content, original, theme]);
  return <div className="code-panel" ref={ref} />;
}
export function TerminalPanel({ taskId }: { taskId?: string }) {
  const theme = usePreferences((state) => state.resolvedTheme);
  const { t } = useI18n();

  const ref = useRef<HTMLDivElement>(null);
  const live = useRef<{ id: string; terminal: XTerminal; exited: boolean } | null>(null);
  const pending = useRef(new Map<string, { data: string; exited: boolean }>());
  const [exited, setExited] = useState(false);
  const [id, setId] = useState<string>();
  const [opening, setOpening] = useState(false);
  const workspace = useStore((state) => state.workspace);
  const terminalTheme = () =>
    usePreferences.getState().resolvedTheme === 'dark'
      ? { background: '#151820', foreground: '#e8ebf4', cursor: '#8b9eff' }
      : { background: '#fbfcff', foreground: '#20283b', cursor: '#526bea' };
  useEffect(() => {
    if (live.current) live.current.terminal.options.theme = terminalTheme();
  }, [theme]);
  useEffect(
    () =>
      api().terminal.subscribe((event) => {
        if (live.current?.id === event.id) {
          live.current.terminal.write(event.data);
          if (event.exited) {
            live.current.exited = true;
            live.current.terminal.options.disableStdin = true;
            setExited(true);
          }
        } else {
          const previous = pending.current.get(event.id);
          pending.current.set(event.id, {
            data: ((previous?.data ?? '') + event.data).slice(-65536),
            exited: !!event.exited || !!previous?.exited,
          });
          if (pending.current.size > 3)
            pending.current.delete(pending.current.keys().next().value!);
        }
      }),
    [],
  );
  useEffect(() => {
    if (!id || !ref.current) return;
    let disposed = false;
    let cleanup = () => {};
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !ref.current) return;
        const term = new Terminal({
          theme: terminalTheme(),
          fontSize: 12,
          scrollback: 2000,
          screenReaderMode: true,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(ref.current);
        const buffered = pending.current.get(id);
        if (buffered) {
          term.write(buffered.data);
          pending.current.delete(id);
        }
        live.current = { id, terminal: term, exited: !!buffered?.exited };
        setExited(!!buffered?.exited);
        term.options.disableStdin = !!buffered?.exited;
        term.focus();
        fit.fit();
        const resize = () => {
          if (live.current?.exited) return;
          fit.fit();
          void perform(() => api().terminal.resize(id, term.cols, term.rows));
        };
        const observer = new ResizeObserver(resize);
        observer.observe(ref.current);
        const input = term.onData((data) => {
          if (!live.current?.exited) void perform(() => api().terminal.write(id, data));
        });
        cleanup = () => {
          observer.disconnect();
          live.current = null;
          pending.current.delete(id);
          input.dispose();
          term.dispose();
        };
        resize();
      })
      .catch((error) => useStore.setState({ error: String(error) }));
    return () => {
      disposed = true;
      cleanup();
      void api()
        .terminal.kill(id)
        .catch(() => {});
    };
  }, [id]);
  return (
    <>
      <Button
        variant="outline"
        disabled={opening || (!workspace && !taskId)}
        onClick={() => {
          if (opening) return;
          setOpening(true);
          void perform(async () => {
            setId(await api().terminal.create(taskId));
          }).finally(() => setOpening(false));
        }}
      >
        {opening ? t('Opening…') : id ? t('Restart terminal') : t('Open terminal')}
      </Button>
      {!workspace && !taskId && (
        <p className="muted">{t('Open a workspace to start an interactive terminal.')}</p>
      )}
      {exited && (
        <p role="status" className="muted">
          {t('Terminal exited. Restart to open a new session.')}
        </p>
      )}
      <div ref={ref} className="terminal-panel" />
    </>
  );
}
export function ChangesPanel({ taskId }: { taskId: string }) {
  const { t } = useI18n();

  const [changes, setChanges] = useState<ChangeDTO[]>([]);
  const events = useStore((s) => s.events);
  const [selected, setSelected] = useState<string>();
  const [reviewing, setReviewing] = useState(false);
  const task = useStore((state) => state.tasks.find((task) => task.id === taskId));
  const revision = events
    .filter(
      (event) =>
        event.taskId === taskId &&
        ['file.changed', 'git.reviewed', 'agent.completed'].includes(event.type),
    )
    .at(-1)?.id;
  const review = async (id: string, action: 'accept' | 'reject' | 'undo') => {
    if (reviewing) return;
    setReviewing(true);
    await perform(async () => {
      await api().git.review(taskId, id, action);
      setChanges(await api().git.changes(taskId));
    });
    setReviewing(false);
  };
  useEffect(() => {
    let disposed = false;
    void api()
      .git.changes(taskId)
      .then((value) => {
        if (!disposed) setChanges(value);
      })
      .catch((error) => useStore.setState({ error: String(error) }));
    return () => {
      disposed = true;
    };
  }, [taskId, revision]);
  const current = changes.find((c) => c.id === selected);
  return (
    <>
      {task?.demo && (
        <p className="muted">
          {t('Simulated Diff · Accept / Reject / Undo affect sample data only.')}
        </p>
      )}
      {task && !['completed', 'failed', 'cancelled', 'paused'].includes(task.status) && (
        <p className="muted">{t('Pause or finish the task before reviewing changes.')}</p>
      )}
      {changes.length === 0 && <p className="muted">{t('No file changes yet.')}</p>}
      {changes.map((change) => (
        <div key={change.id} className="change-row">
          <button onClick={() => setSelected(change.id)}>
            {change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
            {change.exists === false || (change.exists === undefined && change.after === null)
              ? ` ${t('(deleted)')}`
              : ''}
          </button>
          {change.undone ? (
            <span>{t('Undone')}</span>
          ) : (
            <>
              {change.accepted ? (
                <span>{t('Accepted')}</span>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    disabled={
                      reviewing ||
                      change.reviewable === false ||
                      !task ||
                      !['completed', 'failed', 'cancelled', 'paused'].includes(task.status)
                    }
                    onClick={() => void review(change.id, 'accept')}
                  >
                    {t('Accept')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={
                      reviewing ||
                      change.reviewable === false ||
                      !task ||
                      !['completed', 'failed', 'cancelled', 'paused'].includes(task.status)
                    }
                    onClick={() => void review(change.id, 'reject')}
                  >
                    {t('Reject')}
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                disabled={
                  reviewing ||
                  change.reviewable === false ||
                  !task ||
                  !['completed', 'failed', 'cancelled', 'paused'].includes(task.status)
                }
                onClick={() => void review(change.id, 'undo')}
              >
                {t('Undo')}
              </Button>
            </>
          )}
        </div>
      ))}
      {current?.reviewable === false && (
        <p className="muted">
          {t(
            'Large or binary change · review with an external editor. In-app undo is unavailable.',
          )}
        </p>
      )}
      {current && current.reviewable !== false && (
        <CodePanel content={current.after ?? ''} original={current.before ?? ''} />
      )}
    </>
  );
}

export function BrowserPanel({ taskId }: { taskId: string }) {
  const { t } = useI18n();

  const [preview, setPreview] = useState<{ url: string; image?: string }>({ url: '' });
  const events = useStore((s) => s.events);
  const task = useStore((state) => state.tasks.find((task) => task.id === taskId));
  const revision = events
    .filter(
      (event) =>
        event.taskId === taskId &&
        (event.type.startsWith('browser.') ||
          (event.type === 'tool.completed' && String(event.data.tool).startsWith('browser_'))),
    )
    .at(-1)?.id;
  useEffect(() => {
    let active = true;
    void api()
      .browser.preview(taskId)
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((error) => useStore.setState({ error: String(error) }));
    return () => {
      active = false;
    };
  }, [taskId, revision]);
  return (
    <div>
      {task?.demo && (
        <p className="muted">
          {t('Demo Q&A does not launch a browser. Connect a model for browser tools.')}
        </p>
      )}
      <p className="muted">{preview.url || t('Browser tools have not opened a page.')}</p>
      {preview.image ? (
        <img alt={t('Agent browser screenshot')} src={preview.image} style={{ width: '100%' }} />
      ) : (
        <p className="muted">{t('Ask the agent to take a screenshot to preview the page here.')}</p>
      )}
    </div>
  );
}

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
                type={key === 'password' ? 'password' : 'text'}
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
            Task {record.id.slice(0, 8)} · v{record.version}
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
