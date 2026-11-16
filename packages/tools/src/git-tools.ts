import { z } from 'zod';
import { parsePatch } from 'diff';
import { ToolRegistry } from '@hikari/agent-runtime';
import { GitService } from '@hikari/git';
import { FileChangeService } from './patch';

export function registerGitTools(
  registry: ToolRegistry,
  changes: FileChangeService,
  options: { publishDiff?: boolean } = {},
) {
  registry.register({
    name: 'apply_patch',
    description:
      'Preview or apply a multi-file unified diff. Required arguments: {diff, files:[{path,expectedHash}], previewOnly}. Read each file first for its SHA-256; expectedHash=null only for new files. Use --- a/file and +++ b/file headers with correct @@ hunk counts; *** Begin Patch format is NOT supported. Always previewOnly=true first, then apply the identical diff and files with previewOnly=false. If constructing a unified diff fails, use write_file with the hash from read_file. /dev/null headers create/delete files; differing names rename files.',
    permission: 'filesystem.write',
    permissionFor(input) {
      if (input.previewOnly) return 'filesystem.read';
      return parsePatch(input.diff).some(
        (patch) =>
          patch.newFileName === '/dev/null' ||
          (patch.oldFileName !== '/dev/null' &&
            patch.oldFileName !== patch.newFileName &&
            patch.oldFileName?.replace(/^[ab]\//, '') !==
              patch.newFileName?.replace(/^[ab]\//, '')),
      )
        ? 'filesystem.delete'
        : 'filesystem.write';
    },
    schema: z.object({
      diff: z.string().max(512000),
      files: z
        .array(z.object({ path: z.string(), expectedHash: z.string().nullable() }))
        .min(1)
        .max(20),
      previewOnly: z.boolean().default(true),
    }),
    async execute(input, ctx) {
      ctx.signal.throwIfAborted();
      const result = input.previewOnly
        ? await changes.previewFiles(input.files, input.diff)
        : await changes.applyFiles(input.files, input.diff);
      if (!input.previewOnly && options.publishDiff !== false) {
        try {
          ctx.events.emit('git.diff.updated', { diff: await new GitService(ctx.workspace).diff() });
        } catch {
          /* Non-git workspaces still support edits. */
        }
      }
      return { content: JSON.stringify(result) };
    },
  });
  for (const [name, method] of [
    ['git_status', 'status'],
    ['git_diff', 'diff'],
    ['git_log', 'log'],
    ['git_branch', 'branch'],
  ] as const)
    registry.register({
      name,
      description: `Read Git ${method}.`,
      permission: 'filesystem.read',
      schema: z.object({}),
      async execute(_input, ctx) {
        const git = new GitService(ctx.workspace);
        return { content: method === 'diff' ? await git.diff(true) : await git[method]() };
      },
    });
}
