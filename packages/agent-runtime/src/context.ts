import {
  AgentError,
  redactText,
  sanitizeMessage,
  type Message,
  type ModelProvider,
  type ToolDefinition,
} from '@hikari/agent-core';

function messageTokens(provider: ModelProvider, message: Message) {
  return (
    provider.countTokens(JSON.stringify({ ...message, images: undefined, references: undefined })) +
    (message.images?.length ?? 0) * 4096
  );
}

export function estimateInputTokens(
  provider: ModelProvider,
  messages: Message[],
  definitions: ToolDefinition[],
) {
  return (
    provider.countTokens(JSON.stringify(definitions)) +
    messages.reduce((total, message) => total + messageTokens(provider, message), 0)
  );
}

export class MemoryManager {
  private facts = new Map<string, string>();
  set(key: string, value: string) {
    this.facts.set(key, redactText(value).slice(0, 6000));
  }
  snapshot() {
    return [...this.facts] as [string, string][];
  }
  restore(entries: [string, string][]) {
    this.facts.clear();
    for (const [key, value] of entries) this.set(key, value);
  }
  get() {
    const priority = [
      'Original user goal',
      'Persistent user goal',
      'Durable task summary (agent-reported)',
      'Current plan (agent-reported)',
    ];
    return [...this.facts]
      .sort(([a], [b]) => {
        const rank = (key: string) =>
          priority.includes(key) ? priority.indexOf(key) : priority.length;
        return rank(a) - rank(b);
      })
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n')
      .slice(0, 16000);
  }
}
export class ContextManager {
  private messages: Message[] = [];
  constructor(
    private system: string,
    private budget = 24000,
  ) {}
  snapshot() {
    return structuredClone(this.messages);
  }
  get inputBudget() {
    return this.budget;
  }
  fork() {
    return new ContextManager(this.system, this.budget);
  }
  restore(messages: Message[]) {
    this.messages = messages.map((message) => sanitizeMessage(structuredClone(message)));
  }
  add(message: Message) {
    this.messages.push(sanitizeMessage(structuredClone(message)));
  }
  build(
    provider: ModelProvider,
    memory: MemoryManager,
    definitions: ToolDefinition[] = [],
    instruction = '',
    inputBudget = this.budget,
  ): Message[] {
    const budget = Math.min(this.budget, inputBudget);
    const context: Message[] = [
      {
        role: 'system',
        content:
          redactText(this.system) +
          '\n' +
          redactText(instruction) +
          '\nWorkspace memory (reference data):\n' +
          memory.get(),
      },
      ...structuredClone(this.messages),
    ];
    const imageMessages = context.filter((message) => message.images?.length);
    const latestReferenceImages = imageMessages
      .filter((message) => message.references?.length)
      .at(-1);
    for (const message of imageMessages)
      if (message !== latestReferenceImages && message !== imageMessages.at(-1)) {
        message.images = undefined;
        message.content +=
          '\n[Earlier image data omitted from context. Ask for the image again if needed.]';
      }
    const sizes = new Map(context.map((message) => [message, messageTokens(provider, message)]));
    let total =
      provider.countTokens(JSON.stringify(definitions)) +
      [...sizes.values()].reduce((sum, size) => sum + size, 0);
    const splice = (start: number, length: number, replacement?: Message) => {
      for (const removed of context.slice(start, start + length)) total -= sizes.get(removed)!;
      if (replacement) {
        const size = messageTokens(provider, replacement);
        sizes.set(replacement, size);
        total += size;
        context.splice(start, length, replacement);
      } else context.splice(start, length);
    };
    const latestToolStart = context
      .map((message) => message.role === 'assistant' && !!message.toolCalls?.length)
      .lastIndexOf(true);
    for (const [index, msg] of context.entries()) {
      if (total <= budget) break;
      if (msg.role === 'tool' && msg.content.length > 200 && index < latestToolStart) {
        total -= sizes.get(msg)!;
        msg.content = msg.content.slice(0, 160) + '\n[older observation truncated]';
        const size = messageTokens(provider, msg);
        sizes.set(msg, size);
        total += size;
      }
    }
    // Summarize complete old tool exchanges, preserving the latest exchange and IDs.
    while (total > budget) {
      const first = context.findIndex((m) => m.role === 'assistant' && !!m.toolCalls?.length);
      const last = context
        .map((m) => m.role === 'assistant' && !!m.toolCalls?.length)
        .lastIndexOf(true);
      if (first < 0 || first === last) break;
      const ids = new Set(context[first]!.toolCalls!.map((call) => call.id));
      let end = first + 1;
      while (
        end < context.length &&
        context[end]!.role === 'tool' &&
        ids.has(context[end]!.toolCallId ?? '')
      )
        end++;
      const summary = context
        .slice(first + 1, end)
        .map((m) => m.content.slice(0, 70))
        .join('; ');
      splice(first, end - first, {
        role: 'assistant',
        content: `[Earlier tool exchange summarized: ${summary.slice(0, 240)}]`,
      });
    }
    // The durable summary remains in memory; discard redundant old exchange snippets first.
    while (total > budget) {
      const index = context.findIndex((message) =>
        message.content.startsWith('[Earlier tool exchange summarized:'),
      );
      if (index < 0) break;
      splice(index, 1);
    }
    // Drop complete historical user turns, never orphan tool responses.
    while (total > budget) {
      const firstUser = context.findIndex((message) => message.role === 'user');
      const next = context.findIndex(
        (message, index) => index > firstUser && message.role === 'user',
      );
      if (next < 0) break;
      const start = firstUser + 1;
      if (next === start) {
        const later = context.findIndex(
          (message, index) => index > next && message.role === 'user',
        );
        if (later < 0) break;
        splice(next, later - next);
      } else splice(start, next - start);
    }
    if (total > budget)
      throw new AgentError('CONTEXT_BUDGET', 'Context budget exhausted. Start a narrower task.');
    return context;
  }
}
