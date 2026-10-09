import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DemoProvider, demoFiles, demoWorkspace, demoTools } from '../packages/model-provider/src';
import { TaskHost } from '../apps/desktop/src/main/task-host';
import { LocalPersistence } from '../apps/desktop/src/main/persistence';

describe('offline demo', () => {
  const hosts: TaskHost[] = [];
  afterEach(() => {
    for (const host of hosts) host.close();
    hosts.length = 0;
  });
  function host() {
    const host = new TaskHost(() => {});
    hosts.push(host);
    return host;
  }
  it('answers without fetch and carries previous user context', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const provider = new DemoProvider(0);
      const answer = await provider.chat({
        messages: [
          { role: 'user', content: '我的项目是什么' },
          { role: 'assistant', content: 'Example' },
          { role: 'user', content: '继续解释' },
        ],
        tools: [],
        signal: new AbortController().signal,
      });
      expect(answer.text).toContain('模拟回答');
      expect(answer.text).toContain('我的项目是什么');
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  });
  it('only registers virtual tools, rejects paths outside the sample and cancels streams', async () => {
    const tools = demoTools({ ...demoFiles }, () => {});
    expect(tools.map((tool) => tool.name)).toEqual(['read_file', 'demo_apply_fix', 'demo_check']);
    const result = await tools[0]!.execute(
      { path: '/etc/passwd' },
      {
        taskId: 'sample',
        workspace: demoWorkspace.root,
        signal: new AbortController().signal,
        events: { emit() {} },
      },
    );
    expect(result.error).toBe(true);
    const signal = new AbortController();
    const stream = new DemoProvider(100).stream({
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
      signal: signal.signal,
    });
    const pending = stream[Symbol.asyncIterator]().next();
    signal.abort();
    await expect(pending).rejects.toThrow();
  });
  it('simulates fix and review without changing a selected real workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forge-demo-'));
    await writeFile(path.join(root, 'unchanged.txt'), 'keep me');
    try {
      const service = host();
      const task = await service.start('修复示例测试', root);
      await vi.waitFor(() => expect(task.status).toBe('completed'), { timeout: 5000 });
      expect(task.status).toBe('completed');
      expect(task.demo).toBe(true);
      expect(task.workspace).toMatch(/^demo:\/\//);
      expect(await readFile(path.join(root, 'unchanged.txt'), 'utf8')).toBe('keep me');
      expect(task.runSummary?.tests).toEqual([]);
      expect(task.runSummary?.filesChanged).toEqual(['src/cart.ts']);
      const demo = service.demos.get(task.id)!;
      expect(demo.files['src/cart.ts']).toContain('price * quantity');
      service.reviewDemo(task, demo.changes[0]!.id, 'accept');
      expect(demo.changes[0]!.accepted).toBe(true);
      service.reviewDemo(task, demo.changes[0]!.id, 'undo');
      expect(demo.files['src/cart.ts']).toBe(demoFiles['src/cart.ts']);
      const retry = await service.control(task.id, 'retry');
      expect(retry?.id).not.toBe(task.id);
      expect(retry?.demo).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('Plan is read only and retry keeps demo mode after model selection', async () => {
    const service = host();
    const task = await service.start('修复示例测试', '/unused', false, undefined, {
      mode: 'plan',
      maxSteps: 4,
    });
    await vi.waitFor(() => expect(task.status).toBe('completed'), { timeout: 5000 });
    expect(task.status).toBe('completed');
    expect(service.demos.get(task.id)?.changes).toEqual([]);
    expect(task.plan?.steps).toHaveLength(3);
    service.config = {
      provider: 'compatible',
      model: 'invalid',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:1',
    };
    // Retry always keeps a demo task simulated even if a real model has since been selected.
    const retry = await service.control(task.id, 'retry');
    expect(retry?.demo).toBe(true);
  });
  it('persists inherited sample data in follow-ups and restores it without disk tools', async () => {
    const persistence = new LocalPersistence(':memory:');
    try {
      const service = host();
      service.initialize(persistence);
      const parent = await service.start('修复示例测试', '/unused');
      await vi.waitFor(() => expect(parent.status).toBe('completed'), { timeout: 5000 });
      const child = await service.start('继续说明', '/unused', false, parent.id);
      await vi.waitFor(() => expect(child.status).toBe('completed'), { timeout: 5000 });
      const restored = host();
      restored.initialize(persistence);
      expect(restored.tasks.get(child.id).demo).toBe(true);
      expect(restored.demos.get(child.id)?.files['src/cart.ts']).toContain('price * quantity');
    } finally {
      await persistence.close();
    }
  });
  it('real provider failure stays a failed real task', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forge-provider-failure-'));
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Fixture endpoint unavailable'));
    try {
      const service = host();
      service.config = {
        provider: 'compatible',
        model: 'fixture',
        apiKey: '',
        baseUrl: 'http://127.0.0.1:1',
      };
      const task = await service.start('你好', root);
      await vi.waitFor(() => expect(task.status).toBe('failed'));
      expect(task.demo).toBeUndefined();
      expect(task.events.some((event) => event.type === 'agent.completed')).toBe(false);
      expect(service.demos.has(task.id)).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      fetcher.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
