import { expect, it, vi } from 'vitest';
import { retryWorkerRequest } from '../apps/cli/src/worker-transport';
import { apiClient } from '../apps/cli/src/platform';

it('retries transient failures and stops immediately when credentials or a lease are rejected', async () => {
  vi.useFakeTimers();
  try {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }))
      .mockResolvedValue('ok');
    const pending = retryWorkerRequest(operation, {
      signal: new AbortController().signal,
      deadline: Date.now() + 90000,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
    for (const status of [401, 403, 409]) {
      const rejected = vi.fn().mockRejectedValue(Object.assign(new Error('rejected'), { status }));
      await expect(
        retryWorkerRequest(rejected, {
          signal: new AbortController().signal,
          deadline: Date.now() + 90000,
        }),
      ).rejects.toMatchObject({ status });
      expect(rejected).toHaveBeenCalledTimes(1);
    }
  } finally {
    vi.useRealTimers();
  }
});

it('honors cancellation and never retries beyond the renewal deadline', async () => {
  const operation = vi.fn();
  await expect(
    retryWorkerRequest(operation, {
      signal: new AbortController().signal,
      deadline: Date.now() - 1,
    }),
  ).rejects.toThrow('deadline exceeded');
  expect(operation).not.toHaveBeenCalled();
  const controller = new AbortController();
  controller.abort(new Error('operator stopped'));
  await expect(
    retryWorkerRequest(operation, { signal: controller.signal, deadline: Date.now() + 90000 }),
  ).rejects.toThrow('operator stopped');
  expect(operation).not.toHaveBeenCalled();
});

it('preserves proxy HTTP status when the response is HTML or truncated JSON', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  try {
    const api = apiClient('http://127.0.0.1:4319', 'fixture-token');
    for (const status of [401, 403, 409, 429, 502, 503]) {
      fetcher.mockResolvedValueOnce(new Response('<html>proxy error</html>', { status }));
      await expect(api('/worker/claim', {})).rejects.toMatchObject({ status });
    }
    fetcher.mockResolvedValueOnce(new Response('{"commands":', { status: 200 }));
    await expect(api('/worker/jobs/fixture', {})).rejects.toMatchObject({ status: 502 });
  } finally {
    fetcher.mockRestore();
  }
});
