import { realpathSync } from 'node:fs';
import { lstat, readFile, writeFile, mkdir, unlink, chmod, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AgentError } from '@hikari/agent-core';
import { LogicalSandboxProvider } from '@hikari/sandbox';
import { GitService } from './index';
export interface WorktreeFile {
  hash: string;
  mode: number;
  size: number;
}
export interface WorktreeBaseline {
  version: 1;
  taskId: string;
  root: string;
  target: string;
  source: Record<string, WorktreeFile>;
  base: Record<string, WorktreeFile>;
}
export const bufferHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sandbox = new LogicalSandboxProvider();
export function sameWorktreePath(
  left: unknown,
  right: string,
  paths: Pick<typeof path, 'isAbsolute' | 'sep'> = path,
) {
  const key = (value: string) =>
    paths.sep === '\\' ? value.replaceAll('/', '\\').toLowerCase() : value;
  return typeof left === 'string' && paths.isAbsolute(left) && key(left) === key(right);
}
export async function worktreeFiles(root: string) {
  const names = (
    await new GitService(root).run(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  )
    .split('\0')
    .filter(Boolean);
  const files: Record<string, WorktreeFile> = Object.create(null);
  if (names.length > 10000)
    throw new AgentError('WORKTREE_SIZE', 'Worktree operations support at most 10,000 files');
  let bytes = 0;
  for (const name of new Set(names)) {
    if (name.split('/').includes('.agent') || name.split('/').includes('.git')) continue;
    const file = await sandbox.resolve(root, name);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink())
        throw new AgentError('WORKTREE_FILE', `Unsupported symlink or special file: ${name}`);
      bytes += info.size;
      if (info.size > 20000000 || bytes > 200000000)
        throw new AgentError(
          'WORKTREE_SIZE',
          'Worktree operations support 20 MB per file and 200 MB total',
        );
      files[name] = { hash: bufferHash(await readFile(file)), mode: info.mode, size: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return files;
}
export class WorktreeService {
  constructor(readonly root: string) {
    this.root = realpathSync(root);
  }
  private async metadata(directory: string) {
    const target = await sandbox.resolve(this.root, `.agent/${directory}`);
    await mkdir(target, { recursive: true, mode: 0o700 });
    if ((await lstat(target)).isSymbolicLink())
      throw new AgentError('WORKTREE_METADATA', 'Worktree metadata cannot use symbolic links');
    return target;
  }
  private valid(id: string) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id))
      throw new AgentError('INVALID_TASK_ID', 'Invalid task ID');
    return id;
  }
  async create(id: string, source: 'head' | 'working-tree' = 'head') {
    this.valid(id);
    const original = await worktreeFiles(this.root);
    const target = await new GitService(this.root).worktree(id);
    try {
      if (source === 'working-tree') {
        const initial = await worktreeFiles(target);
        for (const name of Object.keys(initial))
          if (!original[name]) await unlink(await sandbox.resolve(target, name, true));
        for (const [name, info] of Object.entries(original)) {
          const bytes = await readFile(await sandbox.resolve(this.root, name));
          if (bufferHash(bytes) !== info.hash)
            throw new AgentError('STALE_FILE', `Source changed during worktree creation: ${name}`);
          const file = await sandbox.resolve(target, name, true);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, bytes);
          await chmod(file, info.mode);
        }
      }
      const manifest: WorktreeBaseline = {
        version: 1,
        taskId: id,
        root: this.root,
        target,
        source: original,
        base: await worktreeFiles(target),
      };
      const directory = await this.metadata('worktree-baselines');
      const tmp = path.join(directory, randomUUID() + '.tmp');
      await writeFile(tmp, JSON.stringify(manifest), { mode: 0o600 });
      await rename(tmp, path.join(directory, `${id}.json`));
      return target;
    } catch (error) {
      // Failed setup is preserved for inspection rather than silently removing a dirty checkout.
      throw new AgentError(
        'WORKTREE_SETUP',
        `Worktree setup failed; preserved at ${target}: ${String(error)}`,
      );
    }
  }
  async baseline(id: string): Promise<WorktreeBaseline> {
    this.valid(id);
    const filename = path.join(await this.metadata('worktree-baselines'), `${id}.json`);
    if ((await lstat(filename)).isSymbolicLink() || (await lstat(filename)).size > 10000000)
      throw new AgentError('WORKTREE_METADATA', 'Invalid worktree manifest');
    const data = JSON.parse(await readFile(filename, 'utf8')) as WorktreeBaseline;
    if (
      data.version !== 1 ||
      !sameWorktreePath(data.root, this.root) ||
      !sameWorktreePath(data.target, path.join(this.root, '.agent', 'worktrees', id))
    )
      throw new AgentError('WORKTREE_METADATA', 'Worktree manifest does not match this project');
    return data;
  }
  async restore(archive: string) {
    const directory = await this.metadata('worktree-archives');
    if (
      !sameWorktreePath(path.dirname(archive), directory) ||
      !/^[a-zA-Z0-9-]+-\d+\.json$/.test(path.basename(archive))
    )
      throw new AgentError('WORKTREE_ARCHIVE', 'Archive is outside this project');
    const info = await lstat(archive);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 280000000)
      throw new AgentError('WORKTREE_ARCHIVE', 'Invalid worktree archive');
    const value = JSON.parse(await readFile(archive, 'utf8')) as {
      version: number;
      baseline: WorktreeBaseline;
      content: Record<string, { data: string; mode: number }>;
    };
    const baseline = await this.baseline(this.valid(value.baseline.taskId));
    if (
      value.version !== 1 ||
      !sameWorktreePath(value.baseline.root, this.root) ||
      !sameWorktreePath(value.baseline.target, baseline.target)
    )
      throw new AgentError('WORKTREE_ARCHIVE', 'Archive does not match this worktree');
    const content = new Map<string, { bytes: Buffer; mode: number }>();
    let bytes = 0;
    for (const [name, file] of Object.entries(value.content)) {
      await sandbox.resolve(this.root, name, true);
      const data = Buffer.from(file.data, 'base64');
      bytes += data.length;
      if (
        data.length > 20000000 ||
        bytes > 200000000 ||
        content.size >= 10000 ||
        !Number.isInteger(file.mode)
      )
        throw new AgentError('WORKTREE_ARCHIVE', 'Archive exceeds supported limits');
      content.set(name, { bytes: data, mode: file.mode & 0o777 });
    }
    await new GitService(this.root).run([
      'worktree',
      'add',
      baseline.target,
      `hikari/${baseline.taskId}`,
    ]);
    const existing = await worktreeFiles(baseline.target);
    for (const name of Object.keys(existing))
      if (!content.has(name)) await unlink(await sandbox.resolve(baseline.target, name, true));
    for (const [name, file] of content) {
      const target = await sandbox.resolve(baseline.target, name, true);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
      await chmod(target, file.mode);
    }
    return baseline.target;
  }
  async archive(id: string) {
    const baseline = await this.baseline(id);
    const files = await worktreeFiles(baseline.target);
    const content: Record<string, { data: string; mode: number }> = Object.create(null);
    for (const [name, info] of Object.entries(files)) {
      const bytes = await readFile(await sandbox.resolve(baseline.target, name));
      if (bufferHash(bytes) !== info.hash)
        throw new AgentError('STALE_FILE', `Worktree changed while archiving ${name}`);
      content[name] = { data: bytes.toString('base64'), mode: info.mode };
    }
    const archive = path.join(await this.metadata('worktree-archives'), `${id}-${Date.now()}.json`);
    await writeFile(archive, JSON.stringify({ version: 1, baseline, content }), { mode: 0o600 });
    // Recheck the content before removing the checkout. No agent is allowed to be active here.
    const latest = await worktreeFiles(baseline.target);
    if (JSON.stringify(latest) !== JSON.stringify(files))
      throw new AgentError(
        'STALE_FILE',
        'Worktree changed; archive retained and cleanup cancelled',
      );
    await new GitService(this.root).run(['worktree', 'remove', '--force', baseline.target]);
    return archive;
  }
}
