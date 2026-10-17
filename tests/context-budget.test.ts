import { expect, it, vi } from 'vitest';
import { ContextManager, MemoryManager } from '../packages/agent-runtime/src';
import { estimateInputTokens } from '../packages/agent-runtime/src/context';
import type { ModelProvider } from '../packages/agent-core/src';

it('compacts a long transcript with linear token counting and preserves the latest tool exchange', () => {
  const provider = {
    countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
  } as unknown as ModelProvider;
  const context = new ContextManager('system', 2000);
  context.add({ role: 'user', content: 'Preserve public APIs' });
  for (let index = 0; index < 180; index++) {
    context.add({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: String(index), name: 'read_file', input: {} }],
    });
    context.add({ role: 'tool', toolCallId: String(index), content: 'x'.repeat(1000) });
  }
  const messages = context.build(provider, new MemoryManager());
  // The previous algorithm re-counted every retained message after each removal.
  expect(vi.mocked(provider.countTokens).mock.calls.length).toBeLessThan(1200);
  expect(estimateInputTokens(provider, messages, [])).toBeLessThanOrEqual(2000);
  expect(messages.some((message) => message.content === 'Preserve public APIs')).toBe(true);
  expect(messages.at(-1)?.toolCallId).toBe('179');
  expect(messages.at(-1)?.content).toHaveLength(1000);
  for (const message of messages.filter((entry) => entry.role === 'tool'))
    expect(
      messages.some((entry) => entry.toolCalls?.some((call) => call.id === message.toolCallId)),
    ).toBe(true);
  expect(context.snapshot()).toHaveLength(361); // Compaction does not corrupt recovery history.
});

it('counts tool arguments and opaque provider state when estimating budget use', () => {
  const provider = { countTokens: (text: string) => text.length } as ModelProvider;
  const messages = [
    {
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: '1', name: 'tool', input: { value: 'x'.repeat(500) } }],
      providerData: { reasoningContent: 'y'.repeat(500) },
    },
  ];
  expect(estimateInputTokens(provider, messages, [])).toBeGreaterThan(1000);
});

it('compacts to a shrinking per-request allowance without losing the stored recovery transcript', () => {
  const provider = { countTokens: (text: string) => text.length } as ModelProvider;
  const context = new ContextManager('system', 20000);
  context.add({ role: 'user', content: 'Preserve the goal' });
  for (let i = 0; i < 8; i++) {
    context.add({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: String(i), name: 'read_file', input: {} }],
    });
    context.add({ role: 'tool', toolCallId: String(i), content: 'x'.repeat(1000) });
  }
  const full = context.build(provider, new MemoryManager());
  const bounded = context.build(provider, new MemoryManager(), [], '', 1600);
  expect(estimateInputTokens(provider, full, [])).toBeGreaterThan(8000);
  expect(estimateInputTokens(provider, bounded, [])).toBeLessThanOrEqual(1600);
  expect(bounded.at(-1)?.toolCallId).toBe('7');
  expect(context.snapshot()).toHaveLength(17);
  expect(context.build(provider, new MemoryManager())).toEqual(full);
});
