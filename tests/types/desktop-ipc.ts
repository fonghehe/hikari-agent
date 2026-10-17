// Compile-only regression tests, included by pnpm typecheck.
import { expectTypeOf } from 'vitest';
import type { Task } from '../../packages/agent-core/src';
import type {
  DesktopAPI,
  DesktopInvokeArgs,
  DesktopInvokeChannel,
  DesktopInvokeHandler,
  DesktopInvokeRawArgs,
  DesktopInvokeResult,
} from '../../packages/shared/src';
import type { RegisterHandler } from '../../apps/desktop/src/main/ipc/context';

expectTypeOf<DesktopInvokeArgs<'workspace:read'>>().toEqualTypeOf<
  [path: string, taskId?: string]
>();
expectTypeOf<DesktopInvokeRawArgs<'workspace:read'>>().toEqualTypeOf<
  [path: unknown, taskId?: unknown]
>();
expectTypeOf<DesktopInvokeArgs<'agent:start'>>().toEqualTypeOf<
  Parameters<DesktopAPI['agent']['start']>
>();
expectTypeOf<DesktopInvokeResult<'agent:start'>>().toEqualTypeOf<Promise<Task>>();
expectTypeOf<DesktopInvokeRawArgs<'agent:list'>>().toEqualTypeOf<[]>();
expectTypeOf<Parameters<DesktopInvokeHandler<'platform:rewind'>>>().toEqualTypeOf<
  [taskId: unknown, checkpointId: unknown, mode: unknown]
>();

declare const register: RegisterHandler;
register('workspace:read', (file, taskId) => {
  expectTypeOf(file).toEqualTypeOf<unknown>();
  expectTypeOf(taskId).toEqualTypeOf<unknown>();
  return 'validated file contents';
});
register('workspace:read', async () => 'validated file contents');
register('agent:list', () => []);

// @ts-expect-error Subscriptions are not invoke channels.
const subscription: DesktopInvokeChannel = 'agent:subscribe';
void subscription;
// @ts-expect-error Invalid channel names must not widen the handler contract.
register('workspace:missing', () => 'contents');
// @ts-expect-error File reads must return text.
register('workspace:read', () => 42);
// @ts-expect-error Async results must obey the same contract.
register('workspace:read', async () => false);
// @ts-expect-error Main-process input cannot be trusted as a string before validation.
register('workspace:read', (file: string) => file);
// @ts-expect-error Required extra arguments cannot be supplied by this channel.
register('workspace:read', (_file, _taskId, _extra: unknown) => 'contents');
// @ts-expect-error A profile response is not a task list.
register('agent:list', () => [{ provider: 'demo', model: 'offline-demo', apiKey: '' }]);
// @ts-expect-error Void channels cannot accidentally return service state.
register('agent:configure', () => ({ apiKey: 'private' }));
