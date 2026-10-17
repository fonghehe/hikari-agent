import { secureStorageAvailable, purgeWeakCredentials } from '../secret-storage';
import { createHash } from 'node:crypto';
import { safeStorage } from 'electron';
import { z } from 'zod';
import { modelConfigSchema, type ModelConfig } from '@hikari/shared';
import { createModelProvider, listModels, resolvedModelConfig } from '@hikari/model-provider';
import type { DesktopContext, RegisterHandler } from './context';

export function registerModelsHandlers(handle: RegisterHandler, context: DesktopContext) {
  const { host, persistence } = context;
  purgeWeakCredentials(safeStorage, () => {
    persistence.repository.db
      .prepare(
        "DELETE FROM model_configs WHERE owner='local' AND (id IN ('provider','profiles') OR substr(id,1,10)='mcp-token:')",
      )
      .run();
  });
  const saved = persistence.get('model_configs', 'provider')?.data;
  if (typeof saved === 'string' && secureStorageAvailable(safeStorage)) {
    try {
      host.config = modelConfigSchema.parse(
        JSON.parse(safeStorage.decryptString(Buffer.from(saved, 'base64'))),
      );
    } catch {
      /* A locked OS keychain requires reconnecting. */
    }
  }
  const savedProfiles = persistence.get('model_configs', 'profiles')?.data;
  if (typeof savedProfiles === 'string' && secureStorageAvailable(safeStorage)) {
    try {
      const profiles = z
        .array(modelConfigSchema)
        .max(30)
        .parse(JSON.parse(safeStorage.decryptString(Buffer.from(savedProfiles, 'base64'))));
      for (const profile of profiles)
        if (profile.profileId) host.profiles.set(profile.profileId, profile);
    } catch {
      /* A locked keychain leaves profiles unavailable until reconfigured. */
    }
  }
  if (host.config && !host.config.profileId)
    host.config.profileId = createHash('sha256')
      .update(JSON.stringify([host.config.provider, host.config.baseUrl, host.config.model]))
      .digest('hex')
      .slice(0, 32);
  if (host.config?.profileId) host.profiles.set(host.config.profileId, host.config);
  const persistProfiles = () => {
    if (secureStorageAvailable(safeStorage)) {
      persistence.save(
        'model_configs',
        'profiles',
        safeStorage.encryptString(JSON.stringify([...host.profiles.values()])).toString('base64'),
      );
      persistence.save(
        'model_configs',
        'provider',
        safeStorage.encryptString(JSON.stringify(host.config ?? null)).toString('base64'),
      );
    }
  };
  const publicConfig = (config: ModelConfig): ModelConfig => ({
    ...config,
    apiKey: '',
    embeddings: config.embeddings ? { ...config.embeddings, apiKey: '' } : undefined,
  });
  handle('agent:configure', (config) => {
    const next = modelConfigSchema.parse(config);
    const key =
      next.profileId ??
      createHash('sha256')
        .update(JSON.stringify([next.provider, next.baseUrl, next.model]))
        .digest('hex')
        .slice(0, 32);
    const old = host.profiles.get(key) ?? host.config;
    if (!next.apiKey && old?.provider === next.provider && old.baseUrl === next.baseUrl)
      next.apiKey = old.apiKey;
    if (
      next.embeddings &&
      !next.embeddings.apiKey &&
      old?.embeddings?.model === next.embeddings.model &&
      old.embeddings.baseUrl === next.embeddings.baseUrl
    )
      next.embeddings.apiKey = old.embeddings.apiKey;
    if (!host.profiles.has(key) && host.profiles.size >= 30)
      throw new Error('At most 30 model profiles are supported');
    host.config = resolvedModelConfig({ ...next, profileId: key });
    host.profiles.set(key, host.config);
    persistProfiles();
  });
  handle('agent:profiles', () => [...host.profiles.values()].map(publicConfig));
  handle('agent:activateProfile', (value) => {
    const profile = host.profiles.get(z.string().max(80).parse(value));
    if (!profile) throw new Error('Unknown model profile');
    host.config = profile;
    persistProfiles();
  });
  handle('agent:removeProfile', (value) => {
    const key = z.string().max(80).parse(value);
    if (
      host.tasks
        .list()
        .some(
          (task) =>
            task.modelProfileId === key &&
            !['completed', 'failed', 'cancelled'].includes(task.status),
        )
    )
      throw new Error('Finish or cancel tasks using this model profile before removing it');
    host.profiles.delete(key);
    if (host.config?.profileId === key) host.config = [...host.profiles.values()][0];
    persistProfiles();
  });
  handle('agent:settings', () => (host.config ? publicConfig(host.config) : undefined));
  handle('agent:configured', () => !!host.config && host.config.provider !== 'demo');
  handle('agent:models', async (value) => {
    const config = modelConfigSchema.parse(value);
    const saved = config.profileId ? host.profiles.get(config.profileId) : host.config;
    if (!config.apiKey && saved?.provider === config.provider && saved.baseUrl === config.baseUrl)
      config.apiKey = saved.apiKey;
    return listModels(config);
  });
  handle('agent:test', async (value) => {
    const config = modelConfigSchema.parse(value);
    const saved = config.profileId ? host.profiles.get(config.profileId) : host.config;
    if (!config.apiKey && saved?.provider === config.provider && saved.baseUrl === config.baseUrl)
      config.apiKey = saved.apiKey;
    if (config.provider === 'demo') return { text: 'Offline mode', tools: false };
    const provider = createModelProvider({
      ...config,
      tokenParameter:
        config.tokenParameter ??
        (config.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'),
    });
    const response = await provider.chat({
      messages: [
        {
          role: 'user',
          content:
            'Call connection_check with {"ok":true}. This is a connection and tool compatibility check; do not perform any external actions.',
        },
      ],
      tools: [
        {
          name: 'connection_check',
          description: 'Confirm connection',
          parameters: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      ],
      maxOutputTokens: 256,
      signal: AbortSignal.timeout(30000),
    });
    return {
      text: response.text,
      tools: response.toolCalls.some((call) => call.name === 'connection_check'),
    };
  });
}
