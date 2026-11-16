import { it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillLoader, registerSkillTools } from '../../packages/skills/src/index';
import { ToolRegistry } from '../../packages/agent-runtime/src/index';
import { MCPService } from '../../packages/mcp/src/index';
it('loads skills on demand and enforces declared tool restrictions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-skills-'));
  try {
    await mkdir(path.join(root, '.agent/skills/review'), { recursive: true });
    await writeFile(
      path.join(root, '.agent/skills/review/SKILL.md'),
      '---\nname: review\ndescription: Review code\nallowed-tools: [read_file]\n---\nInspect before changing.',
    );
    const skills = await new SkillLoader(root).list();
    expect(skills[0]?.instructions).toBe('Inspect before changing.');
    const registry = new ToolRegistry();
    registerSkillTools(registry, root);
    await registry.get('load_skill').execute(
      { name: 'review' },
      {
        taskId: 't',
        workspace: root,
        signal: new AbortController().signal,
        events: { emit() {} },
      },
    );
    expect(() => registry.get('shell')).toThrow('does not allow');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('binds forked skill restrictions to the child and preserves them across further forks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-child-skills-'));
  try {
    await mkdir(path.join(root, '.agent/skills/read'), { recursive: true });
    await writeFile(
      path.join(root, '.agent/skills/read/SKILL.md'),
      '---\nname: read\ndescription: Read only\nallowed-tools: [read_file]\n---\nRead.',
    );
    const parent = new ToolRegistry();
    const { z } = await import('zod');
    for (const name of ['read_file', 'grep'])
      parent.register({
        name,
        description: name,
        permission: 'filesystem.read',
        schema: z.object({}),
        execute: async () => ({ content: 'ok' }),
      });
    registerSkillTools(parent, root);
    const child = parent.fork(() => true);
    await child.get('load_skill').execute(
      { name: 'read' },
      {
        taskId: 'child',
        workspace: root,
        signal: new AbortController().signal,
        events: { emit() {} },
      },
    );
    expect(() => child.get('grep')).toThrow('does not allow');
    expect(parent.get('grep')).toBeDefined();
    const restored = new ToolRegistry();
    restored.restrict(child.restrictions()!);
    expect(restored.restrictions()).not.toContain('grep');
    expect(child.fork(() => true).restrictions()).not.toContain('grep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('discovers, validates and calls a real stdio MCP server', async () => {
  const registry = new ToolRegistry();
  const service = new MCPService(registry, { emit() {} }, process.cwd());
  try {
    const result = await service.connect(
      'fixture',
      {
        transport: 'stdio',
        command: process.execPath,
        args: [path.resolve('tests/fixtures/mcp-server.mjs')],
      },
      new AbortController().signal,
    );
    expect(result.tools).toHaveLength(3);
    const tool = registry.get(result.tools[0]!);
    expect(() => tool.parse({ text: 42 })).toThrow();
    const reply = await tool.execute(tool.parse({ text: 'hello MCP' }), {
      taskId: 't',
      workspace: process.cwd(),
      signal: new AbortController().signal,
      events: { emit() {} },
    });
    expect(reply.content).toContain('hello MCP');
    const context = {
      taskId: 't',
      workspace: process.cwd(),
      signal: new AbortController().signal,
      events: { emit() {} },
    };
    const resource = registry.get(result.tools.find((name) => name.startsWith('mcp_resource_'))!);
    expect(
      (await resource.execute(resource.parse({ uri: 'fixture://reference' }), context)).content,
    ).toContain('Actual MCP reference content');
    await expect(
      resource.execute(resource.parse({ uri: 'file:///unlisted-secret' }), context),
    ).rejects.toThrow('not listed');
    const prompt = registry.get(result.tools.find((name) => name.startsWith('mcp_prompt_'))!);
    expect(
      (
        await prompt.execute(
          prompt.parse({ name: 'review', arguments: { subject: 'the project' } }),
          context,
        )
      ).content,
    ).toContain('Review the project');
  } finally {
    await service.close();
  }
  expect(registry.definitions()).toHaveLength(0);
});

it('attempts every MCP disconnect even if an earlier closer rejects', async () => {
  const registry = new ToolRegistry();
  const service = new MCPService(registry, { emit() {} }, process.cwd());
  const connection = {
    transport: 'stdio' as const,
    command: process.execPath,
    args: [path.resolve('tests/fixtures/mcp-server.mjs')],
  };
  const disconnect = service.disconnect.bind(service);
  let first = true;
  let restore = () => {};
  try {
    await service.connect('first', connection, new AbortController().signal);
    await service.connect('second', connection, new AbortController().signal);
    const fault = vi.spyOn(service, 'disconnect').mockImplementation(async (name) => {
      await disconnect(name);
      if (first) {
        first = false;
        throw new Error('closer failed');
      }
    });
    restore = () => fault.mockRestore();
    await expect(service.close()).rejects.toThrow();
    expect(registry.definitions()).toHaveLength(0);
  } finally {
    restore();
    await service.close();
  }
});
