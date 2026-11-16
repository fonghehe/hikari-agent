import { Dialog } from '../../shared/components/dialog';
import { useI18n } from '../../shared/i18n/index';
import { useEffect, useId, useState } from 'react';
import { Button } from '@hikari/ui';
import { api, perform, useStore } from '../../app/store';
import { providerCatalog, providerApiDocs, type ModelConfig } from '@hikari/shared';

export function ModelSettings({ close }: { close: () => void }) {
  const { t } = useI18n();

  const formId = useId();
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
    <Dialog
      title={t('Model settings')}
      close={close}
      className="model-settings"
      footer={
        <Button type="submit" form={formId} disabled={saving}>
          {saving ? t('Saving…') : t('Connect model')}
        </Button>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          void connect({ ...config, baseUrl: config.baseUrl || undefined });
        }}
      >
        <label>
          {t('Saved model profiles')}
          <select
            aria-label={t('Saved model profiles')}
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
            aria-label={t('Provider')}
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
        {providerApiDocs[config.provider] && (
          <Button
            variant="ghost"
            onClick={() =>
              void window
                .hikari!.external.open(providerApiDocs[config.provider]!)
                .catch((error) => setConnection(String(error)))
            }
          >
            {t('Provider API documentation')}
          </Button>
        )}
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
        <label className="field-wide">
          {t('Base URL')}
          <input
            inputMode="url"
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
          <summary>{t('Reranking')}</summary>
          <p>
            {t(
              'Reranking sends the query and candidate passages to a separate endpoint. Charges are separate from the chat budget. Failures use the fused ranking and are marked in results.',
            )}
          </p>
          <label>
            <input
              type="checkbox"
              checked={config.reranker?.enabled ?? false}
              onChange={(event) =>
                setConfig({
                  ...config,
                  reranker: {
                    model: config.reranker?.model ?? '',
                    baseUrl: config.reranker?.baseUrl ?? 'http://localhost:8000/rerank',
                    apiKey: config.reranker?.apiKey ?? '',
                    enabled: event.target.checked,
                  },
                })
              }
            />{' '}
            {t('Enable reranking')}
          </label>
          {config.reranker && (
            <>
              <label>
                {t('Reranking model')}
                <input
                  value={config.reranker.model}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      reranker: { ...config.reranker!, model: event.target.value },
                    })
                  }
                />
              </label>
              <label>
                {t('Reranking endpoint')}
                <input
                  type="url"
                  value={config.reranker.baseUrl}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      reranker: { ...config.reranker!, baseUrl: event.target.value },
                    })
                  }
                />
              </label>
              <label>
                {t('Reranking API key')}
                <input
                  type="password"
                  value={config.reranker.apiKey}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      reranker: { ...config.reranker!, apiKey: event.target.value },
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
          {(['cachedInputPerMillion', 'cacheWriteInputPerMillion'] as const).map((key) => (
            <label key={key}>
              {t(
                key === 'cachedInputPerMillion'
                  ? 'Cached input price / million tokens (USD)'
                  : 'Cache write price / million tokens (USD)',
              )}
              <input
                type="number"
                min={0}
                step={0.01}
                value={config[key] ?? ''}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    [key]: event.target.value ? Number(event.target.value) : undefined,
                  })
                }
              />
            </label>
          ))}
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
              aria-label={t('Reasoning effort')}
              value={config.reasoningEffort ?? ''}
              onChange={(e) =>
                setConfig({
                  ...config,
                  reasoningEffort: (e.target.value || undefined) as ModelConfig['reasoningEffort'],
                })
              }
            >
              <option value="">{t('Provider default')}</option>
              <option value="low">{t('Low')}</option>
              <option value="medium">{t('Medium')}</option>
              <option value="high">{t('High')}</option>
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
              aria-label={t('Output limit parameter')}
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
      </form>
    </Dialog>
  );
}
