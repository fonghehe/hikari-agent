import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillLoader, registerSkillTools } from '../packages/skills/src';
import { ToolRegistry } from '../packages/agent-runtime/src';
import { MCPService } from '../packages/mcp/src';
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
