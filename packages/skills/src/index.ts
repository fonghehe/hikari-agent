import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { LogicalSandboxProvider } from '@hikari/sandbox';
import { ToolRegistry } from '@hikari/agent-runtime';
import { StateStore } from '@hikari/agent-runtime';
import { pluginManifestSchema } from '@hikari/agent-core';
const metadata = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  'allowed-tools': z.union([z.array(z.string()), z.string()]).optional(),
});
export interface Skill {
  name: string;
  description: string;
  instructions: string;
  allowedTools?: string[];
  path: string;
}
export class SkillLoader {
  constructor(
    private root: string,
    private sandbox = new LogicalSandboxProvider(),
  ) {}
  async list(): Promise<Skill[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(await this.sandbox.resolve(this.root, '.agent/skills'), {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = [];
      else throw error;
    }
    const skills: Skill[] = [];
    const files = entries
      .slice(0, 100)
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ file: `.agent/skills/${entry.name}/SKILL.md`, namespace: '' }));
    for (const plugin of new StateStore(this.root).get<{ name: string }[]>('plugins') ?? []) {
      const name = pluginManifestSchema.shape.name.parse(plugin.name);
      const filename = await this.sandbox.resolve(
        this.root,
        `.agent/plugins/${name}/hikari-plugin.json`,
      );
      const manifest = pluginManifestSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
      for (const skill of manifest.skills)
        files.push({ file: `.agent/plugins/${name}/${skill}/SKILL.md`, namespace: `${name}:` });
    }
    for (const { file, namespace } of files) {
      const target = await this.sandbox.resolve(this.root, file);
      if ((await stat(target)).size > 64000) throw new Error(`Skill exceeds 64 KB: ${file}`);
      const text = await readFile(target, 'utf8');
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
      if (!match) throw new Error(`Missing skill frontmatter: ${file}`);
      const data = metadata.parse(parse(match[1]!));
      const allowed = data['allowed-tools'];
      skills.push({
        name: namespace + data.name,
        description: data.description,
        instructions: match[2]!,
        path: file,
        allowedTools:
          typeof allowed === 'string' ? allowed.split(/[\s,]+/).filter(Boolean) : allowed,
      });
    }
    if (new Set(skills.map((s) => s.name)).size !== skills.length)
      throw new Error('Duplicate skill names');
    return skills;
  }
  async load(name: string) {
    const skill = (await this.list()).find((s) => s.name === name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return skill;
  }
}
export function registerSkillTools(registry: ToolRegistry, root: string) {
  const loader = new SkillLoader(root);
  registry.register({
    name: 'list_skills',
    description: 'List available skill names and descriptions. Load relevant skills on demand.',
    permission: 'filesystem.read',
    schema: z.object({}),
    async execute() {
      return {
        content: JSON.stringify(
          (await loader.list()).map(({ name, description }) => ({ name, description })),
        ),
      };
    },
  });
  registry.register({
    name: 'load_skill',
    description:
      'Load a skill. Its allowed-tools list restricts subsequent tool use; it never grants additional permissions.',
    permission: 'filesystem.read',
    schema: z.object({ name: z.string() }),
    async execute(input, ctx) {
      const skill = await loader.load(input.name);
      if (skill.allowedTools) registry.restrict(skill.allowedTools);
      ctx.events.emit('skill.loaded', { name: skill.name });
      return { content: JSON.stringify(skill) };
    },
  });
}
