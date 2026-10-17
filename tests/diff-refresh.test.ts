import { expect, it, vi } from 'vitest';
import { DiffRefresh } from '../apps/desktop/src/main/diff-refresh';

it('reads a single diff for a burst of file edits', async () => {
  const read = vi.fn(async () => 'final diff'),
    publish = vi.fn();
  const refresh = new DiffRefresh(read, publish);
  for (let index = 0; index < 20; index++) refresh.request();
  await refresh.flush();
  expect(read).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledExactlyOnceWith('final diff');
  refresh.close();
});

it('discards an obsolete in-flight result and serializes the next read', async () => {
  let resolve!: (diff: string) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue('new diff');
  const publish = vi.fn();
  const refresh = new DiffRefresh(read, publish);
  refresh.request();
  const first = refresh.flush();
  refresh.request();
  const second = refresh.flush();
  expect(read).toHaveBeenCalledTimes(1);
  resolve('old diff');
  await Promise.all([first, second]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledExactlyOnceWith('new diff');
  refresh.close();
});

it('does not publish after close and allows a new request after a failed read', async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error('not a Git workspace'))
    .mockResolvedValue('diff');
  const publish = vi.fn();
  const refresh = new DiffRefresh(read, publish);
  refresh.request();
  await refresh.flush();
  refresh.request();
  await refresh.flush();
  expect(publish).toHaveBeenCalledExactlyOnceWith('diff');
  refresh.request();
  refresh.close();
  await refresh.flush();
  expect(read).toHaveBeenCalledTimes(2);
});

it('schedules a request arriving between drain completion and promise cleanup', async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => 'diff');
  let published = 0;
  const refresh = new DiffRefresh(read, () => {
    if (++published === 1) queueMicrotask(() => refresh.request());
  });
  try {
    refresh.request();
    await refresh.flush();
    await vi.advanceTimersByTimeAsync(40);
    expect(read).toHaveBeenCalledTimes(2);
    expect(published).toBe(2);
  } finally {
    refresh.close();
    vi.useRealTimers();
  }
});
