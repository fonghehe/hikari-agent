import { z } from 'zod';

export const workspaceSchema = z.object({
  root: z.string(),
  name: z.string(),
  files: z.array(z.string()),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export interface WorkspaceProject {
  root: string;
  name: string;
  aliases?: string[];
  hidden?: boolean;
  pinned?: boolean;
  section?: string;
}
