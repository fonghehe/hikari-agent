import { expect, it } from 'vitest';
import { z } from '../packages/agent-core/node_modules/zod';
import { ResourceScope, ToolRegistry } from '../packages/agent-runtime/src';

it('closes resources once in reverse order and continues after a failed closer', async () => {
  const scope = new ResourceScope();
  const order: string[] = [];
  scope.defer(() => {
    order.push('workspace');
  });
  scope.defer(async () => {
    order.push('process');
    throw new Error('failed closer');
  });
  scope.defer(() => {
    order.push('tool');
  });
  const closing = scope.close();
  await expect(closing).rejects.toThrow('Resource cleanup failed');
  await expect(scope.close()).rejects.toThrow('Resource cleanup failed');
  expect(order).toEqual(['tool', 'process', 'workspace']);
  expect(() => scope.defer(() => {})).toThrow('closed');
});

it('rolls back scoped tools without deleting a later replacement', async () => {
  const registry = new ToolRegistry();
  const scope = new ResourceScope();
  const tool = {
    name: 'read_fixture',
    description: 'Read fixture',
    schema: z.object({}),
    permission: 'filesystem.read' as const,
    execute: async () => ({ content: 'old' }),
  };
  registry.scope(scope).register(tool);
  expect(registry.definitions().map((tool) => tool.name)).toEqual(['read_fixture']);
  registry.unregister(tool.name);
  registry.register({ ...tool, execute: async () => ({ content: 'new' }) });
  await scope.close();
  expect(await registry.get(tool.name).execute({}, {} as never)).toEqual({ content: 'new' });
  const other = new ResourceScope();
  registry.scope(other).register({ ...tool, name: 'temporary' });
  registry.restrict(['read_fixture']);
  expect(() => registry.scope(other).get('temporary')).toThrow('does not allow');
  await other.close();
  expect(() => registry.get('temporary')).toThrow();
});
