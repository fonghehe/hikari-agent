import { expect, it } from 'vitest';
import { FailureTracker } from '../packages/agent-runtime/src/failures';

const call = { id: 'test', name: 'run_tests', input: { command: 'node', args: ['test.mjs'] } };
it('recognizes recurring failures despite volatile timestamps, temporary paths and durations', () => {
  const tracker = new FailureTracker();
  for (let index = 1; index <= 3; index++)
    expect(
      tracker.record(
        call,
        {
          error: true,
          content: `2026-10-17T01:00:0${index}.000Z failure /private/tmp/run-${index}/test.mjs took ${index * 10} ms`,
          metadata: { errorCode: 'TEST_FAILURE' },
        },
        0,
      ),
    ).toBe(index);
});

it('does not let repeated identical observations hide failure loops, but resets for new evidence and edits', () => {
  const tracker = new FailureTracker();
  const failure = { error: true, content: 'TypeError: wrong result' };
  const read = { id: 'read', name: 'read_file', input: { path: 'test.mjs' } };
  tracker.record(read, { content: 'original file' }, 0);
  for (let index = 1; index <= 3; index++) {
    expect(tracker.record(call, failure, 0)).toBe(index);
    tracker.record(read, { content: 'original file' }, 0);
  }
  tracker.record(read, { content: 'new diagnostics' }, 0);
  expect(tracker.record(call, failure, 0)).toBe(1);
  expect(tracker.record(call, failure, 1)).toBe(1);
  expect(tracker.record({ ...call, input: { command: 'different' } }, failure, 1)).toBe(1);
});
