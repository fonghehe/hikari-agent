import { readdir, readFile, open } from 'node:fs/promises';
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
export type SkillMetadata = Omit<Skill, 'instructions'>;
export interface SkillDiagnostic {
  path: string;
  message: string;
}
function parseMetadata(header: string, namespace: string, path: string): SkillMetadata {
  const data = metadata.parse(parse(header));
  const allowed = data['allowed-tools'];
  return {
    name: namespace + data.name,
    description: data.description,
    path,
    allowedTools: typeof allowed === 'string' ? allowed.split(/[\s,]+/).filter(Boolean) : allowed,
  };
}
export class SkillLoader {
  constructor(
    private root: string,
    private sandbox = new LogicalSandboxProvider(),
  ) {}
  async discover(): Promise<{ skills: SkillMetadata[]; diagnostics: SkillDiagnostic[] }> {
    const diagnostics: SkillDiagnostic[] = [];
    const report = (path: string, error: unknown) =>
      diagnostics.push({ path, message: error instanceof Error ? error.message : String(error) });
    let entries: Dirent[];
    try {
      entries = await readdir(await this.sandbox.resolve(this.root, '.agent/skills'), {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = [];
      else {
        entries = [];
        report('.agent/skills', error);
      }
    }
    const skills: SkillMetadata[] = [];
    const files = entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, 100)
      .map((entry) => ({ file: `.agent/skills/${entry.name}/SKILL.md`, namespace: '' }));
    let plugins: { name: string }[] = [];
    try {
      plugins = z
        .array(z.object({ name: z.string() }))
        .max(100)
        .parse(new StateStore(this.root, false).get('plugins') ?? []);
    } catch (error) {
      report('.agent/state/plugins.json', error);
    }
    for (const plugin of plugins) {
      try {
        const name = pluginManifestSchema.shape.name.parse(plugin.name);
        const filename = await this.sandbox.resolve(
          this.root,
          `.agent/plugins/${name}/hikari-plugin.json`,
        );
        const manifest = pluginManifestSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
        for (const skill of manifest.skills)
          files.push({ file: `.agent/plugins/${name}/${skill}/SKILL.md`, namespace: `${name}:` });
      } catch (error) {
        report(`.agent/plugins/${plugin.name}/hikari-plugin.json`, error);
      }
    }
    for (const { file, namespace } of files) {
      try {
        const target = await this.sandbox.resolve(this.root, file);
        const handle = await open(target, 'r');
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > 64000)
            throw new Error(`Skill exceeds 64 KB or is not a file: ${file}`);
          const chunks: Buffer[] = [];
          let bytes = 0;
          while (bytes < info.size) {
            const buffer = Buffer.alloc(Math.min(512, info.size - bytes));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
            if (!bytesRead) break;
            chunks.push(buffer.subarray(0, bytesRead));
            bytes += bytesRead;
            const text = Buffer.concat(chunks).toString('utf8');
            const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
            if (match) {
              skills.push(parseMetadata(match[1]!, namespace, file));
              break;
            }
            if (bytes === info.size) throw new Error(`Missing skill frontmatter: ${file}`);
          }
          if (!bytes) throw new Error(`Missing skill frontmatter: ${file}`);
        } finally {
          await handle.close();
        }
      } catch (error) {
        report(file, error);
      }
    }
    const names = new Map<string, SkillMetadata[]>();
    for (const skill of skills) names.set(skill.name, [...(names.get(skill.name) ?? []), skill]);
    for (const [name, entries] of names)
      if (entries.length > 1)
        for (const entry of entries) report(entry.path, new Error(`Duplicate skill name: ${name}`));
    return {
      skills: skills
        .filter((skill) => names.get(skill.name)!.length === 1)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      diagnostics,
    };
  }
  async list(): Promise<Skill[]> {
    const discovered = await this.discover();
    const result: Skill[] = [];
    for (const skill of discovered.skills) {
      try {
        result.push(await this.read(skill));
      } catch {
        /* A concurrently removed skill cannot hide valid entries. */
      }
    }
    return result;
  }
  private async read(skill: SkillMetadata): Promise<Skill> {
    const target = await this.sandbox.resolve(this.root, skill.path);
    const handle = await open(target, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64000) throw new Error(`Invalid skill size: ${skill.path}`);
      const text = await handle.readFile('utf8');
      if (Buffer.byteLength(text) > 64000) throw new Error(`Invalid skill size: ${skill.path}`);
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
      if (!match) throw new Error(`Missing skill frontmatter: ${skill.path}`);
      const namespace = skill.path.startsWith('.agent/plugins/')
        ? `${skill.path.split('/')[2]}:`
        : '';
      const current = parseMetadata(match[1]!, namespace, skill.path);
      if (current.name !== skill.name)
        throw new Error('Skill changed during loading; list skills again');
      return { ...current, instructions: match[2]! };
    } finally {
      await handle.close();
    }
  }
  async load(name: string) {
    const { skills, diagnostics } = await this.discover();
    const skill = skills.find((s) => s.name === name);
    if (!skill)
      throw new Error(
        `Unknown or invalid skill: ${name}. ${diagnostics
          .map((d) => d.message)
          .join('; ')
          .slice(0, 2000)}`,
      );
    return this.read(skill);
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
      const { skills, diagnostics } = await loader.discover();
      return {
        content: JSON.stringify(skills.map(({ name, description }) => ({ name, description }))),
        metadata: { diagnostics },
      };
    },
  });
  registry.registerFactory<{ name: string }>((owner) => ({
    name: 'load_skill',
    description:
      'Load a skill. Its allowed-tools list restricts subsequent tool use; it never grants additional permissions.',
    permission: 'filesystem.read',
    schema: z.object({ name: z.string() }),
    async execute(input, ctx) {
      const skill = await loader.load(input.name);
      if (skill.allowedTools) owner.restrict(skill.allowedTools);
      ctx.events.emit('skill.loaded', { name: skill.name });
      return { content: JSON.stringify(skill) };
    },
  }));
}
