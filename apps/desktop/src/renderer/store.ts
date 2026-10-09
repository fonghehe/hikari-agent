import { tr } from './i18n';
import { create } from 'zustand';
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
  error: string;
  configured: boolean;
  starting: boolean;
  opening: boolean;
  notice: string;
  open(): Promise<void>;
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
let refreshSequence = 0;
export const useStore = create<Store>((set, get) => ({
  workspace: null,
  tasks: [],
  events: [],
  activeId: null,
  error: '',
  configured: false,
  starting: false,
  opening: false,
  notice: '',
  async open() {
    if (get().opening) return;
    set({ opening: true });
    try {
      const workspace = await api().workspace.open();
      if (workspace)
        set({ workspace, error: '', notice: tr('Opened {name}', { name: workspace.name }) });
      else set({ notice: tr('Workspace selection cancelled.') });
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ opening: false });
    }
  },
  async refresh() {
    const sequence = ++refreshSequence;
    const tasks = await api().agent.list();
    if (sequence === refreshSequence) set({ tasks });
  },
  async start(prompt, isolated, parentTaskId, options, attachmentIds) {
    if (get().starting) return false;
    set({ starting: true, error: '', notice: tr('Starting task…') });
    try {
      const task = await api().agent.start(prompt, isolated, parentTaskId, options, attachmentIds);
      set((state) => ({
        activeId: task.id,
        error: '',
        notice: '',
        tasks: [...state.tasks.filter((old) => old.id !== task.id), task],
      }));
      await get().refresh();
      return true;
    } catch (error) {
      set({ error: String(error) });
      return false;
    } finally {
      set({ starting: false });
    }
  },
  receive(event) {
    set((state) => ({
      events: [...state.events.filter((e) => e.id !== event.id), event].slice(-2000),
    }));
    if (
      [
        'agent.state',
        'plan.updated',
        'agent.run.summary',
        'agent.question',
        'agent.answer',
        'agent.usage',
      ].includes(event.type)
    )
      void get()
        .refresh()
        .catch((error) => set({ error: String(error) }));
  },
}));
export async function perform(action: () => Promise<unknown>) {
  try {
    await action();
    useStore.setState({ error: '' });
  } catch (error) {
    useStore.setState({ error: String(error) });
  }
}
