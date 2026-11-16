import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillLoader, registerSkillTools } from '../../packages/skills/src/index';
import { ToolRegistry } from '../../packages/agent-runtime/src/index';
import type { ToolContext } from '../../packages/agent-core/src/index';

it('lists valid skills independently of invalid and duplicate entries without creating private state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-skill-discovery-'));
  const put = async (name: string, text: string) => {
    const directory = path.join(root, '.agent/skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), text);
  };
  try {
    await put('z', '---\nname: z\ndescription: Last\n---\nBody Z');
    await put('bad', 'invalid');
    await put('a', '---\nname: a\ndescription: First\n---\nBody A');
    await put('dup1', '---\nname: duplicate\ndescription: One\n---\none');
    await put('dup2', '---\nname: duplicate\ndescription: Two\n---\ntwo');
    const loader = new SkillLoader(root);
    expect((await loader.list()).map((skill) => skill.name)).toEqual(['a', 'z']);
    await expect(loader.load('duplicate')).rejects.toThrow(/Duplicate/);
    await expect(access(path.join(root, '.agent/state'))).rejects.toThrow();
    await writeFile(
      path.join(root, '.agent/skills/a/SKILL.md'),
      '---\nname: a\ndescription: Changed\nallowed-tools: [grep]\n---\nChanged body',
    );
    expect(await loader.load('a')).toMatchObject({
      instructions: 'Changed body',
      allowedTools: ['grep'],
    });
    await rm(path.join(root, '.agent/skills/a'), { recursive: true });
    await expect(loader.load('a')).rejects.toThrow(/Unknown/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps metadata discovery bounded and rejects escaped skill files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-skill-header-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'hikari-outside-skill-'));
  try {
    await mkdir(path.join(root, '.agent/skills/large'), { recursive: true });
    await writeFile(
      path.join(root, '.agent/skills/large/SKILL.md'),
      '---\nname: large\ndescription: Large\n---\n' + 'body'.repeat(15000),
    );
    await mkdir(path.join(root, '.agent/skills/escape'), { recursive: true });
    await writeFile(
      path.join(outside, 'SKILL.md'),
      '---\nname: escape\ndescription: Escape\n---\nsecret',
    );
    await symlink(path.join(outside, 'SKILL.md'), path.join(root, '.agent/skills/escape/SKILL.md'));
    const tools = new ToolRegistry();
    registerSkillTools(tools, root);
    const response = await tools.get('list_skills').execute({}, {} as ToolContext);
    expect(JSON.parse(response.content)).toEqual([{ name: 'large', description: 'Large' }]);
    expect(response.metadata?.diagnostics).toBeDefined();
    expect(response.content).not.toContain('body');
    await expect(access(path.join(root, '.agent/state'))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
