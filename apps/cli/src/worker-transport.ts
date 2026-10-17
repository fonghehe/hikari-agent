import { setTimeout as delay } from 'node:timers/promises';

export function transientWorkerError(error: unknown) {
  const status = (error as { status?: number } | null)?.status;
  if (status !== undefined) return [408, 429, 500, 502, 503, 504].includes(status);
  return (
    error instanceof TypeError ||
    (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
  );
}

/** Retry only protocol operations carrying an idempotency ID, within the current lease. */
export async function retryWorkerRequest<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: {
    signal: AbortSignal;
    deadline: number;
    onRetry?(attempt: number): void;
  },
): Promise<T> {
  let attempt = 0;
  while (true) {
    options.signal.throwIfAborted();
    const remaining = options.deadline - Date.now();
    if (remaining <= 0)
      throw Object.assign(new Error('Worker reconnect deadline exceeded; inspect the saved task'), {
        status: 408,
      });
    try {
      return await operation(
        AbortSignal.any([options.signal, AbortSignal.timeout(Math.min(30000, remaining))]),
      );
    } catch (error) {
      options.signal.throwIfAborted();
      if (!transientWorkerError(error) || Date.now() >= options.deadline) throw error;
      options.onRetry?.(++attempt);
      await delay(
        Math.min(500 * 2 ** Math.min(attempt - 1, 4), 5000, options.deadline - Date.now()),
        undefined,
        { signal: options.signal },
      );
    }
  }
}
