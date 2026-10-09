import { setTimeout as delay } from 'node:timers/promises';
import { AgentError } from '@hikari/agent-core';
export async function providerFetch(url: string, options: RequestInit, attempts = 3) {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      if (options.signal?.aborted || attempt + 1 >= attempts) throw error;
      await delay(Math.min(5000, 300 * 2 ** attempt), undefined, {
        signal: options.signal ?? undefined,
      });
      continue;
    }
    if (response.ok) return response;
    if ([408, 429, 500, 502, 503, 504, 529].includes(response.status) && attempt + 1 < attempts) {
      const retry = response.headers.get('retry-after');
      const seconds = retry ? Number(retry) : NaN;
      const ms =
        retry && !Number.isFinite(seconds) ? Date.parse(retry) - Date.now() : seconds * 1000;
      await response.body?.cancel();
      await delay(
        Math.max(0, Math.min(10000, Number.isFinite(ms) ? ms : 300 * 2 ** attempt)),
        undefined,
        { signal: options.signal ?? undefined },
      );
      continue;
    }
    await response.body?.cancel();
    throw new AgentError(
      response.status === 429
        ? 'MODEL_RATE_LIMIT'
        : [401, 403].includes(response.status)
          ? 'MODEL_AUTH'
          : response.status === 400
            ? 'MODEL_REQUEST'
            : 'PROVIDER_HTTP',
      `Model endpoint returned HTTP ${response.status}`,
    );
  }
}
