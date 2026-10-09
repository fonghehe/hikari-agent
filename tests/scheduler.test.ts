import { it, expect } from 'vitest';
import { TaskScheduler, TaskManager, AgentRunner } from '../packages/agent-runtime/src';
it('limits parallel work and retains workspace locks until completion', async () => {
  const scheduler = new TaskScheduler(2);
  const manager = new TaskManager();
  const releases: (() => void)[] = [];
  const runner = () =>
    ({
      run: () => new Promise<void>((resolve) => releases.push(resolve)),
      cancel() {},
    }) as AgentRunner;
  const first = manager.create('first', '/one');
  const runs = [
    scheduler.submit(first, runner()),
    scheduler.submit(manager.create('second', '/two'), runner()),
    scheduler.submit(manager.create('third', '/three'), runner()),
  ];
  expect(scheduler.activeCount).toBe(2);
  expect(scheduler.queuedCount).toBe(1);
  expect(() => scheduler.submit(manager.create('conflict', '/one'), runner())).toThrow(
    'owns this workspace',
  );
  releases[0]!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(scheduler.activeCount).toBe(2);
  expect(scheduler.queuedCount).toBe(0);
  releases[1]!();
  releases[2]!();
  await Promise.all(runs);
});
