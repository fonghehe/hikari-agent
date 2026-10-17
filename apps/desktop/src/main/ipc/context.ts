import { z } from 'zod';
import type { BrowserWindow } from 'electron';
import type { DesktopInvokeChannel, DesktopInvokeHandler } from '@hikari/shared';
import type { TaskHost } from '../task-host';
import type { TerminalSessions } from '../terminal';
import type { LocalPersistence } from '../persistence';
import { WorkspaceProjects } from '../projects';

export const id = z.string().uuid();
export type RegisterHandler = <Channel extends DesktopInvokeChannel>(
  name: Channel,
  handler: DesktopInvokeHandler<Channel>,
) => void;
export interface DesktopContext {
  window: BrowserWindow;
  host: TaskHost;
  persistence: LocalPersistence;
  terminals: TerminalSessions;
  workspaceState: { root?: string; require(): string };
  openTaskWindow?(id: string): Promise<void>;
}

/** Project settings use their explicit project without changing the window's selected workspace. */
export async function resolveProjectRoot(
  context: Pick<DesktopContext, 'persistence' | 'workspaceState'> & {
    host: Pick<TaskHost, 'tasks'>;
  },
  input?: unknown,
): Promise<string> {
  if (input === undefined) return context.workspaceState.require();
  const root = z.string().trim().min(1).max(4096).parse(input);
  const projects = new WorkspaceProjects(context.persistence, () => context.host.tasks.list());
  return (await projects.find(root)).root;
}
