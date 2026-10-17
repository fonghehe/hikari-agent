import { setTimeout as delay } from 'node:timers/promises';
import { AgentError, redact } from '@hikari/agent-core';

async function errorDetail(response: Response, options: RequestInit): Promise<string> {
  let text = '';
  const reader = response.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (bytes < 4096) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value.subarray(0, 4096 - bytes), { stream: true });
        bytes += value.byteLength;
      }
      text += decoder.decode();
    } catch {
      // An unreadable error body must not hide the HTTP status.
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  try {
    const payload: unknown = JSON.parse(text);
    if (typeof payload === 'object' && payload !== null) {
      const error = 'error' in payload ? (payload.error ?? payload) : payload;
      if (typeof error === 'object' && error !== null)
        text = [
          'code' in error ? error.code : undefined,
          'type' in error ? error.type : undefined,
          'message' in error ? error.message : undefined,
        ]
          .filter((value): value is string => typeof value === 'string')
          .join(': ');
    }
  } catch {
    // Some gateways return plain text or HTML instead of JSON.
  }
  const headers = new Headers(options.headers);
  const credentials = [...headers]
    .filter(([name]) => /authorization|api[-_]?key|token|secret/i.test(name))
    .flatMap(([, value]) => [value, value.replace(/^Bearer\s+/i, '')])
    .filter(Boolean);
  let detail = [
    text,
    response.headers.get('x-request-id')
      ? `request-id=${response.headers.get('x-request-id')}`
      : '',
  ]
    .filter(Boolean)
    .join('; ');
  for (const credential of credentials) detail = detail.split(credential).join('[REDACTED]');
  return String(redact(detail))
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 1200);
}
export async function providerFetch(
  url: string,
  options: RequestInit,
  attempts = 3,
): Promise<Response> {
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
    const detail = await errorDetail(response, options);
    throw new AgentError(
      response.status === 429
        ? 'MODEL_RATE_LIMIT'
        : [401, 403].includes(response.status)
          ? 'MODEL_AUTH'
          : response.status === 400
            ? 'MODEL_REQUEST'
            : 'PROVIDER_HTTP',
      `Model endpoint returned HTTP ${response.status}${detail ? ': ' + detail : ''}`,
    );
  }
}
