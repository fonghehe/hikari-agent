import path from 'node:path';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  lstat,
  writeFile,
  rename,
  rm,
  realpath,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pluginManifestSchema, type PluginManifest } from '@hikari/agent-core';
import { StateStore } from '@hikari/agent-runtime';

const isURL = (source: string) => /^https?:\/\//i.test(source);
async function fetchPackageJSON(source: string, limit: number) {
  const url = new URL(source);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Plugin downloads require HTTPS; HTTP is allowed only on loopback');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw new Error(`Plugin download failed: ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > limit) throw new Error('Plugin download exceeds size limit');
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
}

async function packageFiles(root: string) {
  const files: { relative: string; bytes: Buffer }[] = [];
  let bytes = 0;
  const walk = async (folder: string, depth = 0) => {
    if (depth > 8) throw new Error('Plugin nesting exceeds eight directories');
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const filename = path.join(folder, entry.name);
      const info = await lstat(filename);
      if (info.isSymbolicLink()) throw new Error('Plugin packages cannot contain symbolic links');
      if (info.isDirectory()) await walk(filename, depth + 1);
      else if (info.isFile()) {
        if (info.size > 2000000 || bytes + info.size > 20000000 || files.length >= 200)
          throw new Error('Plugin exceeds package limits');
        const content = await readFile(filename);
        bytes += content.length;
        if (content.length > 2000000 || bytes > 20000000)
          throw new Error('Plugin exceeds package limits');
        files.push({
          relative: path.relative(root, filename).split(path.sep).join('/'),
          bytes: content,
        });
      } else throw new Error('Unsupported plugin file');
    }
  };
  if ((await lstat(root)).isSymbolicLink())
    throw new Error('Plugin root cannot be a symbolic link');
  await walk(root);
  const digest = createHash('sha256');
  for (const file of files.sort((a, b) =>
    a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0,
  )) {
    digest
      .update(file.relative)
      .update('\0')
      .update(String(file.bytes.length))
      .update('\0')
      .update(file.bytes);
  }
  return { files, sha256: digest.digest('hex') };
}
export async function inspectPlugin(source: string) {
  const data = await packageFiles(source);
  const manifestFile = data.files.find((file) => file.relative === 'hikari-plugin.json');
  if (!manifestFile) throw new Error('Missing hikari-plugin.json');
  const manifest = pluginManifestSchema.parse(JSON.parse(manifestFile.bytes.toString('utf8')));
  for (const skill of manifest.skills) {
    if (
      skill.split('/').some((part) => !part || part === '.' || part === '..') ||
      !data.files.some((file) => file.relative === `${skill}/SKILL.md`)
    )
      throw new Error(`Missing or invalid plugin skill: ${skill}`);
  }
  return { ...data, manifest };
}
export interface InstalledPlugin {
  name: string;
  version: string;
  description: string;
  sha256: string;
  source: string;
}
export async function packPlugin(source: string, output: string) {
  const inspected = await inspectPlugin(source);
  await writeFile(
    output,
    JSON.stringify({
      format: 'hikari-plugin-bundle',
      version: 1,
      files: inspected.files.map((file) => ({
        path: file.relative,
        base64: file.bytes.toString('base64'),
      })),
    }),
    { mode: 0o600, flag: 'wx' },
  );
  return {
    name: inspected.manifest.name,
    version: inspected.manifest.version,
    sha256: inspected.sha256,
    path: output,
  };
}
export class PluginManager {
  private state: StateStore;
  constructor(readonly root: string) {
    this.state = new StateStore(root);
  }
  list() {
    return this.state.get<InstalledPlugin[]>('plugins') ?? [];
  }
  async install(
    source: string,
    expectedDigest?: string,
    replace = false,
    identity?: { name: string; version: string },
  ) {
    if (isURL(source)) {
      if (!expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest))
        throw new Error('Remote plugin installation requires a pinned SHA-256');
      const bundle = z
        .object({
          format: z.literal('hikari-plugin-bundle'),
          version: z.literal(1),
          files: z
            .array(
              z.object({
                path: z.string().min(1).max(1000),
                base64: z
                  .string()
                  .max(2700000)
                  .regex(/^[A-Za-z0-9+/]*={0,2}$/),
              }),
            )
            .min(1)
            .max(200),
        })
        .parse(await fetchPackageJSON(source, 28000000));
      const temporary = await mkdtemp(path.join(this.state.directory, 'plugin-download-'));
      try {
        let total = 0;
        for (const file of bundle.files) {
          if (
            file.path.includes('\\') ||
            file.path.includes(':') ||
            file.path
              .split('/')
              .some(
                (part) =>
                  !part ||
                  part === '.' ||
                  part === '..' ||
                  part === '.git' ||
                  part === 'node_modules',
              )
          )
            throw new Error('Invalid bundled plugin path');
          const bytes = Buffer.from(file.base64, 'base64');
          total += bytes.length;
          if (bytes.length > 2000000 || total > 20000000)
            throw new Error('Plugin exceeds package limits');
          const filename = path.join(temporary, file.path);
          await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
          await writeFile(filename, bytes, { mode: 0o600, flag: 'wx' });
        }
        return await this.installLocal(temporary, expectedDigest, replace, source, identity);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    return this.installLocal(source, expectedDigest, replace, undefined, identity);
  }
  private async installLocal(
    source: string,
    expectedDigest?: string,
    replace = false,
    provenance?: string,
    identity?: { name: string; version: string },
  ) {
    const value = await inspectPlugin(source);
    if (
      identity &&
      (value.manifest.name !== identity.name || value.manifest.version !== identity.version)
    )
      throw new Error('Plugin identity does not match registry');
    if (expectedDigest && value.sha256 !== expectedDigest)
      throw new Error('Plugin digest does not match registry');
    return this.state.transactionAsync('plugins', async () => {
      const all = this.list();
      if (all.length >= 100) throw new Error('At most 100 installed plugins');
      if (all.some((item) => item.name === value.manifest.name) && !replace)
        throw new Error('Plugin already installed; use update');
      const folder = path.join(this.root, '.agent', 'plugins');
      if (
        await lstat(folder).then(
          (info) => info.isSymbolicLink(),
          () => false,
        )
      )
        throw new Error('Plugin directory cannot be a symlink');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const staging = path.join(folder, randomUUID());
      const target = path.join(folder, value.manifest.name);
      const backup = path.join(folder, randomUUID());
      await mkdir(staging, { mode: 0o700 });
      let moved = false;
      try {
        for (const file of value.files) {
          const filename = path.join(staging, file.relative);
          await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
          await writeFile(filename, file.bytes, { mode: 0o600, flag: 'wx' });
        }
        const record = {
          name: value.manifest.name,
          version: value.manifest.version,
          description: value.manifest.description,
          sha256: value.sha256,
          source: provenance ?? (await realpath(source)),
        };
        if (replace && all.some((item) => item.name === record.name)) {
          await rename(target, backup);
          moved = true;
        }
        await rename(staging, target);
        try {
          this.state.set('plugins', [...all.filter((item) => item.name !== record.name), record]);
        } catch (error) {
          await rm(target, { recursive: true, force: true });
          if (moved) await rename(backup, target);
          throw error;
        }
        if (moved) await rm(backup, { recursive: true, force: true });
        return record;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }
  async remove(name: string) {
    pluginManifestSchema.shape.name.parse(name);
    return this.state.transactionAsync('plugins', async () => {
      const all = this.list();
      if (!all.some((item) => item.name === name)) throw new Error('Unknown plugin');
      // Move out of the discovery path before changing the lock file.
      const target = path.join(this.root, '.agent', 'plugins', name);
      const archived = target + '-' + randomUUID();
      await rename(target, archived);
      try {
        this.state.set(
          'plugins',
          this.list().filter((item) => item.name !== name),
        );
      } catch (error) {
        await rename(archived, target);
        throw error;
      }
      await rm(archived, { recursive: true, force: true });
    });
  }
  async registry(filename: string) {
    const registry = z
      .object({
        plugins: z
          .array(
            z.object({
              name: pluginManifestSchema.shape.name,
              version: pluginManifestSchema.shape.version,
              path: z.string().min(1),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
              description: z.string().max(1000),
            }),
          )
          .max(200),
      })
      .parse(
        isURL(filename)
          ? await fetchPackageJSON(filename, 1000000)
          : JSON.parse(await readFile(filename, 'utf8')),
      );
    return registry.plugins.map((entry) => ({
      ...entry,
      path: isURL(filename)
        ? new URL(entry.path, filename).href
        : isURL(entry.path)
          ? entry.path
          : path.resolve(path.dirname(filename), entry.path),
    }));
  }
}
export async function installedManifests(
  root: string,
): Promise<{ manifest: PluginManifest; directory: string }[]> {
  const result = [];
  for (const plugin of new PluginManager(root).list()) {
    const directory = path.join(root, '.agent', 'plugins', plugin.name);
    const inspected = await inspectPlugin(directory);
    if (inspected.sha256 !== plugin.sha256)
      throw new Error(
        `Installed plugin changed: ${plugin.name}; reinstall to approve its contents`,
      );
    result.push({ manifest: inspected.manifest, directory });
  }
  return result;
}
export const expandPlugin = (text: string, directory: string) =>
  text.split('${plugin}').join(directory);
