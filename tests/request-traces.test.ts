import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AgentRunner,
  ContextManager,
  EventBus,
  FileRunStore,
  MemoryManager,
  TaskManager,
  ToolRegistry,
} from '../packages/agent-runtime/src';
import type { ModelRequest, ModelProvider } from '../packages/agent-core/src';
import { LocalPersistence } from '../apps/desktop/src/main/persistence';

it('saves the prepared adapter input privately before the model runs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-traces-'));
  const store = new FileRunStore(root);
  const tasks = new TaskManager();
  const task = tasks.create('inspect', root);
  task.modelIdentity = { provider: 'compatible', model: 'fixture' };
  let admitted: ModelRequest | undefined;
  const provider: ModelProvider = {
    countTokens: (text) => text.length / 4,
    async chat() {
      return { text: 'done', toolCalls: [] };
    },
    async *stream(request) {
      admitted = request;
      expect(store.requests(task.id)).toHaveLength(1);
      yield await this.chat(request);
    },
  };
  try {
    await new AgentRunner(task, {
      tasks,
      tools: new ToolRegistry(),
      provider,
      context: new ContextManager('private system context'),
      memory: new MemoryManager(),
      events: new EventBus(task),
      permissions: { check: async () => true },
      checkpoints: store,
    }).run();
    expect(task.status).toBe('completed');
    const [trace] = store.requests(task.id);
    expect(trace?.messages).toEqual(admitted?.messages);
    expect(trace?.tools).toEqual(admitted?.tools);
    expect(trace?.model).toEqual(task.modelIdentity);
    expect(JSON.stringify(task.events)).not.toContain('private system context');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('bounds and sanitizes private request records in both storage backends', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-trace-retention-'));
  const file = new FileRunStore(root);
  const desktop = new LocalPersistence(':memory:');
  const taskId = randomUUID();
  try {
    for (let step = 0; step < 20; step++) {
      const record = {
        version: 1 as const,
        id: randomUUID(),
        step,
        createdAt: new Date().toISOString(),
        inputBudget: 1000,
        estimatedInputTokens: 10,
        maxOutputTokens: 100,
        messages: [{ role: 'user' as const, content: 'sk-privatecredential1234' }],
        tools: [],
        compaction: {
          sourceMessages: 1,
          admittedMessages: 1,
          truncatedResults: 0,
          summarizedExchanges: 0,
          removedTurns: 0,
          omittedImages: 0,
        },
      };
      file.saveRequest(taskId, record);
      desktop.checkpoints.saveRequest(taskId, record);
    }
    for (const records of [file.requests(taskId), desktop.checkpoints.requests(taskId)]) {
      expect(records).toHaveLength(16);
      expect(records[0]?.step).toBe(4);
      expect(records.at(-1)?.step).toBe(19);
      expect(JSON.stringify(records)).not.toContain('sk-privatecredential1234');
    }
    desktop.removeTaskOutputs(taskId);
    expect(desktop.checkpoints.requests(taskId)).toEqual([]);
  } finally {
    file.close();
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('marks oversized snapshots explicitly without failing or retaining their input', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-large-trace-'));
  const store = new FileRunStore(root);
  const taskId = randomUUID();
  try {
    store.saveRequest(taskId, {
      version: 1,
      id: randomUUID(),
      step: 1,
      createdAt: new Date().toISOString(),
      messages: [{ role: 'user', content: 'x'.repeat(8000001) }],
      tools: [],
      inputBudget: 1000,
      estimatedInputTokens: 1000,
      maxOutputTokens: 100,
      compaction: {
        sourceMessages: 1,
        admittedMessages: 1,
        truncatedResults: 0,
        summarizedExchanges: 0,
        removedTurns: 0,
        omittedImages: 0,
      },
    });
    const [record] = store.requests(taskId);
    expect(record?.omitted).toBe('size-limit');
    expect(record?.messages).toEqual([]);
    expect(record?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record).length).toBeLessThan(2000);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
