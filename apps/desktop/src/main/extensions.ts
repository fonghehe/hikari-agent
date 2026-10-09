import { mkdir, readFile, writeFile, rename, rm, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { connectionSchema } from '@hikari/mcp';
import { SkillLoader } from '@hikari/skills';
import { LogicalSandboxProvider } from '@hikari/sandbox';
const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export class ExtensionManager {
  private sandbox = new LogicalSandboxProvider();
  constructor(private root: string) {}
  async list() {
    let mcp = {};
    try {
      mcp = z
        .record(connectionSchema)
        .parse(
          JSON.parse(
            await readFile(await this.sandbox.resolve(this.root, '.agent/mcp.json'), 'utf8'),
          ),
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const skills = (await new SkillLoader(this.root).list()).map(
      ({ name, description, path: filename }) => ({
        name,
        description,
        directory: path.basename(path.dirname(filename)),
      }),
    );
    return { mcp, skills };
  }
  async server(name: string, config: unknown | null) {
    nameSchema.parse(name);
    const current = (await this.list()).mcp as Record<string, unknown>;
    if (config === null) delete current[name];
    else current[name] = connectionSchema.parse(config);
    const folder = await this.sandbox.resolve(this.root, '.agent');
    await mkdir(folder, { recursive: true });
    const filename = await this.sandbox.resolve(this.root, '.agent/mcp.json');
    const temporary = path.join(folder, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async installSkill(source: string) {
    if ((await this.list()).skills.length >= 100)
      throw new Error('At most 100 skills can be installed');
    const directory = nameSchema.parse(path.basename(source));
    const target = await this.sandbox.resolve(this.root, `.agent/skills/${directory}`);
    try {
      await lstat(target);
      throw new Error('A skill with this directory is already installed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const files: { relative: string; bytes: Buffer }[] = [];
    let total = 0;
    const walk = async (folder: string, relative = '') => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (entry.isSymbolicLink()) throw new Error('Skill imports cannot contain symbolic links');
        const rel = path.join(relative, entry.name),
          filename = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          if (rel.split(path.sep).length > 6)
            throw new Error('Skill directory nesting exceeds limit');
          await walk(filename, rel);
        } else if (entry.isFile()) {
          const info = await lstat(filename);
          if (info.size > 1000000) throw new Error('A skill file exceeds 1 MB');
          const bytes = await readFile(filename);
          total += bytes.length;
          if (total > 20000000 || files.length >= 100)
            throw new Error('Skill import exceeds 100 files / 20 MB');
          files.push({ relative: rel, bytes });
        }
      }
    };
    await walk(source);
    if (!files.some((file) => file.relative === 'SKILL.md'))
      throw new Error('Choose a skill folder containing SKILL.md');
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true });
    const staging = path.join(parent, `import-${randomUUID()}`);
    try {
      for (const file of files) {
        const filename = path.join(staging, file.relative);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, file.bytes, { mode: 0o600 });
      }
      // Parse before publishing the installed skill, and reject duplicate public names.

      const text = await readFile(path.join(staging, 'SKILL.md'), 'utf8');
      if (text.length > 64000 || !/^---\r?\n/.test(text))
        throw new Error('Skill needs valid frontmatter and must be at most 64 KB');
      await rename(staging, target);
      try {
        await new SkillLoader(this.root).list();
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  async removeSkill(directory: string) {
    nameSchema.parse(directory);
    const target = await this.sandbox.resolve(this.root, `.agent/skills/${directory}`);
    await rm(target, { recursive: true, force: true });
  }
}
