import { tr, localizedError } from '../shared/i18n/index';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { states, taskPlanSchema, runSummarySchema } from '@hikari/agent-core';
import type { AgentEvent, Task, RunOptions } from '@hikari/agent-core';
import type { DesktopAPI, Workspace } from '@hikari/shared';
declare global {
  interface Window {
    hikari?: DesktopAPI;
    /** @deprecated Use hikari; retained for existing integrations. */
    forge?: DesktopAPI;
  }
}
export function api() {
  if (!window.hikari)
    throw new Error('Open the Electron desktop app to connect a local workspace.');
  return window.hikari;
}
interface Store {
  workspace: Workspace | null;
  tasks: Task[];
  events: AgentEvent[];
  activeId: string | null;
  draftSection: string | null;
  error: string;
  configured: boolean;
  starting: boolean;
  opening: boolean;
  projectsRevision: number;
  notice: string;
  open(kind?: 'directory' | 'file'): Promise<boolean>;
  addProject(path: string, name?: string): Promise<boolean>;
  selectWorkspace(root: string | null): Promise<boolean>;
  restoreWorkspace(): Promise<void>;
  refresh(): Promise<void>;
  start(
    prompt: string,
    isolated?: boolean,
    parentTaskId?: string,
    options?: RunOptions,
    attachmentIds?: string[],
  ): Promise<boolean>;
  receive(event: AgentEvent): void;
}
let refreshQueued = false;
let refreshRequest: Promise<void> | undefined;
let workspaceRevision = 0;
export const useStore = create<Store>((set, get) => ({
  workspace: null,
  tasks: [],
  events: [],
  activeId: null,
  draftSection: null,
  error: '',
  configured: false,
  starting: false,
  opening: false,
  projectsRevision: 0,
  notice: '',
  async open(kind) {
    if (get().opening || get().starting) return false;
    workspaceRevision++;
    set({ opening: true });
    try {
      const workspace = await api().workspace.open(kind);
      if (workspace)
        set({
          workspace,
          activeId: null,
          error: '',
          notice: tr('Opened {name}', { name: workspace.name }),
          projectsRevision: get().projectsRevision + 1,
        });
      else set({ notice: tr('Workspace selection cancelled.') });
      return !!workspace;
    } catch (error) {
      set({ error: localizedError(error) });
      return false;
    } finally {
      set({ opening: false });
    }
  },
  async addProject(path, name) {
    if (get().opening || get().starting) return false;
    workspaceRevision++;
    set({ opening: true });
    try {
      const workspace = await api().workspace.add({ path, name });
      set({
        workspace,
        activeId: null,
        error: '',
        notice: '',
        projectsRevision: get().projectsRevision + 1,
      });
      return true;
    } catch (error) {
      set({ error: localizedError(error) });
      return false;
    } finally {
      set({ opening: false });
    }
  },
  async refresh() {
    refreshQueued = true;
    if (!refreshRequest)
      refreshRequest = Promise.resolve().then(async () => {
        try {
          while (refreshQueued) {
            refreshQueued = false;
            try {
              const tasks = await api().agent.list();
              if (!refreshQueued) set({ tasks });
            } catch (error) {
              // Consume an already-requested trailing snapshot even if this one
              // failed. With no queued work, report the error without retrying.
              if (!refreshQueued) throw error;
            }
          }
        } finally {
          refreshRequest = undefined;
        }
      });
    return refreshRequest;
  },
  async selectWorkspace(root) {
    if (get().opening || get().starting) return false;
    workspaceRevision++;
    if (root !== null && get().workspace?.root === root) {
      set({ activeId: null, error: '', notice: '' });
      return true;
    }
    set({ opening: true });
    try {
      const workspace = root
        ? await api().workspace.select(root)
        : (await api().workspace.clear(), null);
      set({ workspace, activeId: null, error: '', notice: '' });
      return true;
    } catch (error) {
      set({ error: localizedError(error) });
      return false;
    } finally {
      set({ opening: false });
    }
  },
  async restoreWorkspace() {
    const revision = workspaceRevision;
    const workspace = await api().workspace.snapshot();
    if (revision === workspaceRevision && workspace && !get().workspace && !get().opening)
      set({ workspace });
  },
  async start(prompt, isolated, parentTaskId, options, attachmentIds) {
    if (get().starting || get().opening) return false;
    set({ starting: true, error: '', notice: tr('Starting task…') });
    try {
      const task = await api().agent.start(
        prompt,
        isolated,
        parentTaskId,
        options,
        attachmentIds,
        parentTaskId ? undefined : (get().draftSection ?? undefined),
      );
      set((state) => ({
        activeId: task.id,
        draftSection: null,
        error: '',
        notice: '',
        tasks: [...state.tasks.filter((old) => old.id !== task.id), task],
      }));
      await get().refresh();
      return true;
    } catch (error) {
      set({ error: localizedError(error) });
      return false;
    } finally {
      set({ starting: false });
    }
  },
  receive(event) {
    set((state) => {
      const status =
        event.type === 'agent.state'
          ? states.find((value) => value === event.data.state)
          : undefined;
      const plan = event.type === 'plan.updated' ? taskPlanSchema.safeParse(event.data) : undefined;
      const summary =
        event.type === 'agent.run.summary' ? runSummarySchema.safeParse(event.data) : undefined;
      const changed = state.tasks.some(
        (task) =>
          task.id === event.taskId &&
          ((status && status !== task.status) || plan?.success || summary?.success),
      );
      const tasks = changed
        ? state.tasks.map((task) => {
            if (task.id !== event.taskId) return task;
            if (status === task.status && !plan?.success && !summary?.success) return task;
            return {
              ...task,
              ...(status ? { status } : {}),
              ...(plan?.success ? { plan: plan.data } : {}),
              ...(summary?.success ? { runSummary: summary.data } : {}),
              updatedAt: event.timestamp,
            };
          })
        : state.tasks;
      return {
        events: [...state.events.filter((e) => e.id !== event.id), event].slice(-2000),
        tasks,
      };
    });
    if (
      [
        'agent.state',
        'plan.updated',
        'agent.run.summary',
        'agent.work.updated',
        'agent.intent',
        'agent.question',
        'agent.answer',
        'agent.usage',
      ].includes(event.type)
    )
      void get()
        .refresh()
        .catch((error) => set({ error: localizedError(error) }));
  },
}));
/** Stable selection: events from unrelated tasks must not invalidate this subscriber. */
export function useTaskEvents(taskId: string | null) {
  return useStore(useShallow((state) => state.events.filter((event) => event.taskId === taskId)));
}
export async function perform(action: () => Promise<unknown>) {
  try {
    await action();
    useStore.setState({ error: '' });
  } catch (error) {
    useStore.setState({ error: localizedError(error) });
  }
}
