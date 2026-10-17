import { TaskActions, WorktreeActions } from './task-actions';
import { SidebarSettings, WorkspaceTools } from './sidebar-menus';
import { TaskNavigation } from './task-navigation';
import { ComposerProject } from './composer-project';
import { isProjectTask } from './project-navigation';
import { WorkspaceSettings } from './workspace-settings';
import { TaskOptions, UserInput } from './run-settings';
import type { WorkspaceProject } from '@hikari/shared';
import { Dialog } from './dialog';
import type { RunOptions } from '@hikari/agent-core';
import { useI18n } from './i18n';
import { Answer } from './answer';
import { AttachButton, AttachmentList, useComposerDraft } from './attachments';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowUp,
  BrainCircuit,
  FolderOpen,
  Plus,
  PanelRight,
  SlidersHorizontal,
  X,
  GitBranch,
  ChevronRight,
  FileCode2,
  Terminal,
  ArrowUpRight,
  Sparkles,
  List,
  Pause,
  Play,
  Square,
  CheckCircle2,
} from 'lucide-react';
import { Button } from '@hikari/ui';
import type { AgentEvent, PermissionRequest, Decision } from '@hikari/agent-core';
import { api, perform, useStore } from './store';
import {
  ChangesPanel,
  CodePanel,
  ModelSettings,
  TerminalPanel,
  BrowserPanel,
  SyncPanel,
} from './panels';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { AppearanceSettings } from './appearance-settings';
import { FileTree } from './file-tree';
import { initializePreferences } from './preferences';
import { TaskProgress } from './task-progress';
function Timeline({ events }: { events: AgentEvent[] }) {
  const { t, locale } = useI18n();

  const taskId = useStore((s) => s.activeId);
  const visible = events.filter(
    (event) =>
      ![
        'agent.message.delta',
        'agent.state',
        'tool.stdout',
        'git.diff.updated',
        'plan.updated',
        'agent.run.summary',
      ].includes(event.type),
  );
  const terminal = events.some((event) =>
    ['agent.completed', 'agent.failed', 'agent.cancelled'].includes(event.type),
  );
  const foreground = (event: AgentEvent) =>
    ['agent.completed', 'agent.failed', 'agent.cancelled'].includes(event.type) ||
    (event.type === 'permission.requested' &&
      !terminal &&
      !events.some(
        (other) =>
          ['permission.approved', 'permission.denied'].includes(other.type) &&
          other.data.id === (event.data.request as unknown as PermissionRequest)?.id,
      ));
  const activity = visible.filter((event) => !foreground(event));
  const renderEvent = (event: AgentEvent) => {
    const request =
      event.type === 'permission.requested'
        ? (event.data.request as unknown as PermissionRequest)
        : null;
    const settled =
      request &&
      events.some(
        (e) =>
          ['permission.approved', 'permission.denied'].includes(e.type) && e.data.id === request.id,
      );
    return (
      <div
        key={event.id}
        data-event-type={event.type}
        className={`timeline-item ${event.type === 'agent.completed' ? 'success' : ''}`}
      >
        <span className="timeline-dot" />
        <details
          open={
            (!!request && !settled && !terminal) ||
            ['agent.completed', 'agent.failed', 'agent.cancelled'].includes(event.type)
          }
        >
          <summary>
            {event.type === 'agent.completed' ? <CheckCircle2 size={14} /> : null}
            {t(`event.${event.type}`)}
            {event.data.tool ? ` · ${String(event.data.tool)}` : ''}
            <time>{new Date(event.timestamp).toLocaleTimeString(locale)}</time>
          </summary>
          {['agent.completed', 'agent.message.delta'].includes(event.type) ? (
            <Answer text={String(event.data.text)} />
          ) : (
            <pre>{JSON.stringify(event.data, null, 2)}</pre>
          )}
          {request && !settled && !terminal && (
            <div className="approval">
              <p>
                {t(
                  'Approve this operation? Commands and external tools run with your user account permissions.',
                )}
              </p>
              {(['once', 'session', 'always', 'deny'] as Decision[]).map((decision) => (
                <Button
                  key={decision}
                  variant={decision === 'deny' ? 'ghost' : 'outline'}
                  onClick={() =>
                    void perform(() => api().agent.approve(taskId!, request.id, decision))
                  }
                >
                  {
                    {
                      once: t('Allow once'),
                      session: t('Allow for session'),
                      always: t('Always allow'),
                      deny: t('Deny'),
                    }[decision]
                  }
                </Button>
              ))}
            </div>
          )}
        </details>
      </div>
    );
  };
  return (
    <div className="timeline">
      {activity.length > 0 && (
        <details className="agent-activity">
          <summary>{t('Activity ({count})', { count: activity.length })}</summary>
          {activity.map(renderEvent)}
        </details>
      )}
      {visible.filter(foreground).map(renderEvent)}
    </div>
  );
}

function App() {
  const { t, locale } = useI18n();

  const fileRequest = useRef(0);
  const { workspace, error, notice, open, tasks, activeId, events, configured, starting } =
    useStore();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [history, setHistory] = useState(false);
  useEffect(() => setHistory(false), [workspace]);
  const [showArchived, setShowArchived] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [browsing, setBrowsing] = useState<typeof workspace>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const draft = useComposerDraft(activeId ?? 'new');
  const { prompt, setPrompt, attachments, importing } = draft;
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const textarea = promptRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.max(activeId ? 64 : 100, Math.min(260, textarea.scrollHeight))}px`;
    }
  }, [prompt, activeId]);
  const [isolated, setIsolated] = useState(false);
  const [mode, setMode] = useState<'plan' | 'execute'>('execute');
  const [runSettings, setRunSettings] = useState<Partial<RunOptions>>({});
  const [maxSteps, setMaxSteps] = useState(30);
  const [taskSearch, setTaskSearch] = useState('');
  const [settings, setSettings] = useState(false);
  const [taskOptions, setTaskOptions] = useState(false);
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceProject | null>(null);
  const [dataSettings, setDataSettings] = useState(false);
  const [syncSettings, setSyncSettings] = useState(false);
  const [appearance, setAppearance] = useState(false);
  const [tab, setTab] = useState<'files' | 'diff' | 'terminal' | 'browser'>('files');
  const [file, setFile] = useState<{ name: string; content: string }>();
  const draftSection = useStore((state) => state.draftSection);
  const currentSection =
    tasks.find((task) => task.id === activeId)?.navigation?.section ??
    (!activeId ? draftSection : null);
  const active = tasks.find((t) => t.id === activeId);
  const projectSettingsRoot = active
    ? isProjectTask(active)
      ? active.workspace
      : null
    : workspace?.root;
  const composerWorkspace = active?.chat
    ? t('Conversation only')
    : active?.demo
      ? t('Demo · no workspace needed')
      : active
        ? (active.workspace
            .replace(/[\\/]+$/, '')
            .split(/[\\/]/)
            .at(-1) ?? active.workspace)
        : workspace?.name;
  const taskEvents = events.filter((e) => e.taskId === activeId);
  const visibleEvents = [
    ...new Map(
      [...(active?.events ?? []), ...taskEvents].map((event) => [event.id, event]),
    ).values(),
  ];
  const simulated = active ? !!active.demo : !configured;
  const terminal = !active || ['completed', 'failed', 'cancelled'].includes(active.status);
  const filteredTasks = tasks
    .filter((task) => showArchived || !task.archived)
    .filter((task) =>
      `${task.title} ${task.workspace}`.toLowerCase().includes(taskSearch.toLowerCase()),
    )
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const pausePending =
    !terminal &&
    visibleEvents
      .slice()
      .reverse()
      .find((event) => ['agent.pause_requested', 'agent.resume_requested'].includes(event.type))
      ?.type === 'agent.pause_requested';
  const lastThinking = visibleEvents.map((event) => event.type).lastIndexOf('agent.thinking');
  const liveText = terminal
    ? ''
    : visibleEvents
        .slice(lastThinking + 1)
        .filter((event) => event.type === 'agent.message.delta')
        .map((event) => String(event.data.text))
        .join('');
  const newTask = (section?: string) => {
    const current = useStore.getState();
    const selected = current.tasks.find((task) => task.id === current.activeId);
    if (selected && isProjectTask(selected) && current.workspace?.root !== selected.workspace) {
      void current.selectWorkspace(selected.workspace).then((success) => {
        if (success) newTask(section);
      });
      return;
    }
    useStore.setState({ activeId: null, draftSection: section ?? null, error: '', notice: '' });
    draft.clear('new');
    setFile(undefined);
    setHistory(false);
    setTaskOptions(false);
    setIsolated(false);
    setMode('execute');
    setMaxSteps(30);
    setRunSettings({});
    requestAnimationFrame(() => promptRef.current?.focus());
  };
  const showPanel = (name: typeof tab) => {
    setTab(name);
    setInspectorOpen(true);
  };
  const control = async (action: 'pause' | 'resume' | 'cancel' | 'retry') => {
    if (!active || controlling) return;
    setControlling(true);
    await perform(async () => {
      const next = await api().agent.control(active.id, action);
      if (next) useStore.setState({ activeId: next.id });
      await useStore.getState().refresh();
    });
    setControlling(false);
  };
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 1180px)');
    const changed = () => {
      if (narrow.matches) setInspectorOpen(false);
    };
    narrow.addEventListener('change', changed);
    return () => narrow.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'n' &&
        !document.querySelector('dialog[open]')
      ) {
        event.preventDefault();
        newTask();
      }
      if (event.key === 'Escape') {
        if (window.innerWidth <= 1180) setInspectorOpen(false);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [settings, appearance, taskOptions]);
  const fileRevision = visibleEvents
    .filter(
      (event) =>
        event.type === 'file.changed' ||
        event.type === 'agent.completed' ||
        event.type === 'git.reviewed',
    )
    .at(-1)?.id;
  useEffect(() => {
    let cancelled = false;
    fileRequest.current++;
    setFile(undefined);
    setLoadingFiles(true);
    void api()
      .workspace.snapshot(activeId ?? undefined)
      .then((value) => {
        if (!cancelled) setBrowsing(value);
      })
      .catch((error) => {
        if (!cancelled) useStore.setState({ error: String(error) });
      })
      .finally(() => {
        if (!cancelled) setLoadingFiles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, workspace?.root, fileRevision]);
  useEffect(() => {
    const selected = useStore.getState().tasks.find((task) => task.id === activeId);
    if (selected) {
      setMode(selected.runOptions?.mode ?? 'execute');
      setMaxSteps(selected.runOptions?.maxSteps ?? 30);
      setRunSettings(selected.runOptions ?? {});
    }
  }, [activeId]);
  useEffect(() => {
    if (!window.hikari) return;
    const off = api().agent.subscribe((event) => useStore.getState().receive(event));
    void perform(async () => {
      await initializePreferences();
      await useStore.getState().refresh();
      useStore.setState({ configured: await api().agent.configured() });
      const selectedWorkspace = await api().workspace.snapshot();
      if (selectedWorkspace && !useStore.getState().workspace && !useStore.getState().opening)
        useStore.setState({ workspace: selectedWorkspace });
      const requested = new URLSearchParams(window.location.search).get('task');
      const selected = useStore.getState().tasks.find((task) => task.id === requested);
      if (selected) {
        if (isProjectTask(selected)) await useStore.getState().selectWorkspace(selected.workspace);
        useStore.setState({ activeId: selected.id });
      }
    });
    return off;
  }, []);
  const send = () => {
    if (starting || importing) return;
    if (active && !['completed', 'failed', 'cancelled'].includes(active.status)) {
      if (!prompt.trim() || attachments.length) {
        useStore.setState({
          error: t(
            'Send text instructions during execution. Send attachments after this turn finishes.',
          ),
        });
        return;
      }
      if (active.status === 'interrupted') {
        useStore.setState({ error: t('Resume the task before adding instructions.') });
        return;
      }
      void perform(async () => {
        await api().agent.input(active.id, prompt.trim());
        draft.clear(active.id);
        useStore.setState({ notice: t('Instructions queued for the next step.') });
      });
      return;
    }
    const key = activeId ?? 'new';
    if (prompt.trim() || attachments.length)
      void useStore
        .getState()
        .start(
          prompt.trim() || t('Summarize the attached files and images.'),
          active || mode === 'plan' || !workspace ? false : isolated,
          active?.id,
          {
            ...runSettings,
            mode,
            maxSteps,
          },
          attachments.map((file) => file.id),
        )
        .then((success) => {
          if (success) draft.clear(key);
        });
  };
  const composer = (
    <>
      <div
        className={`composer ${dragging ? 'dragging' : ''}`}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          setDragging(false);
          if (!starting) void draft.importFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {dragging && <div className="drop-hint">{t('Drop files or images here')}</div>}
        <AttachmentList files={attachments} remove={starting ? undefined : draft.remove} />
        <textarea
          ref={promptRef}
          aria-label={active ? t('Follow-up prompt') : t('Task prompt')}
          placeholder={
            active ? t('Continue this conversation…') : t('What would you like to work on?')
          }
          value={prompt}
          disabled={starting}
          onChange={(event) => setPrompt(event.target.value)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length) {
              event.preventDefault();
              if (!starting) void draft.importFiles(files);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-bottom">
          <div className="composer-context">
            <AttachButton busy={importing || starting} pick={() => void draft.pick()} />
            {currentSection && (
              <span className="composer-section" title={currentSection}>
                <List size={14} />
                <span>{currentSection}</span>
              </span>
            )}
            <ComposerProject
              locked={!!active}
              label={composerWorkspace}
              title={active?.chat ? t('Conversation only') : (active?.workspace ?? workspace?.root)}
              changed={() => {
                setIsolated(false);
                setFile(undefined);
                setHistory(false);
                requestAnimationFrame(() => promptRef.current?.focus());
              }}
            />
          </div>
          <div className="composer-actions">
            <button
              className="icon-button task-options-trigger"
              aria-label={t('Task options')}
              title={t('Task options')}
              onClick={() => setTaskOptions(true)}
            >
              <SlidersHorizontal size={15} />
              {mode === 'plan' && <span>{t('Plan')}</span>}
            </button>
            <button
              className="model-label"
              aria-label={configured ? t('Model settings') : t('Configure model')}
              title={configured ? t('Model settings') : t('Configure model')}
              onClick={() => setSettings(true)}
            >
              <Sparkles size={13} />
              <span>{configured ? t('Model connected') : t('Demo mode · offline')}</span>
            </button>
            <Button
              aria-label={active ? t('Send follow-up') : t('Start task')}
              disabled={
                starting ||
                importing ||
                (!prompt.trim() && !attachments.length) ||
                active?.status === 'interrupted'
              }
              onClick={send}
            >
              <ArrowUp size={16} />
            </Button>
          </div>
        </div>
      </div>
      {projectSettingsRoot && (
        <div className="conversation-project-tools">
          <button
            className="conversation-project-settings"
            title={projectSettingsRoot}
            onClick={() =>
              void perform(async () => {
                const projects = await api().workspace.recent();
                const project = projects.find(
                  (item) =>
                    item.root === projectSettingsRoot ||
                    item.aliases?.includes(projectSettingsRoot),
                );
                setWorkspaceSettings(
                  project ?? {
                    root: projectSettingsRoot,
                    name: composerWorkspace ?? projectSettingsRoot,
                  },
                );
              })
            }
          >
            <BrainCircuit size={14} />
            <span>{t('Memory & extensions')}</span>
          </button>
        </div>
      )}
      {importing && (
        <p role="status" className="attachment-feedback">
          {t('Preparing attachments…')}
        </p>
      )}
      {draft.errors.length > 0 && (
        <div role="alert" className="attachment-errors">
          {draft.errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <p className="attachment-help">
          {t('Attachments go to your connected model. Demo stays offline.')}
        </p>
      )}
    </>
  );
  return (
    <div className={`app ${inspectorOpen ? 'panel-open' : 'panel-closed'}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <img src="./hikari-icon.svg" alt="" />
          </span>
          hikari
        </div>
        <Button variant="ghost" className="new-task" onClick={() => newTask()}>
          <Plus size={17} />
          {t('New task')}
          <span>⌘ N</span>
        </Button>
        <input
          className="task-search"
          aria-label={t('Search tasks')}
          placeholder={t('Search task history…')}
          value={taskSearch}
          onChange={(event) => setTaskSearch(event.target.value)}
        />
        <TaskNavigation
          tasks={filteredTasks}
          search={taskSearch}
          create={newTask}
          historyActive={history}
          history={() => {
            setHistory(true);
            useStore.setState({ activeId: null });
          }}
          select={(task) => {
            setHistory(false);
            useStore.setState({ activeId: task.id });
          }}
        />
        <SidebarSettings
          model={() => setSettings(true)}
          appearance={() => setAppearance(true)}
          data={() => setDataSettings(true)}
          sync={() => setSyncSettings(true)}
        />
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            {currentSection ?? t('Workspace')}
            <ChevronRight size={13} />
            <span title={active?.title ?? t('New task')}>{active?.title ?? t('New task')}</span>
          </div>
          <div className="header-actions">
            {active && (
              <span className="local-pill">
                <span className="status-dot" />
                <span>{t(`status.${active.status}`)}</span>
              </span>
            )}
            <WorkspaceTools open={showPanel} />
            <Button
              variant="ghost"
              aria-label={t('Toggle right panel')}
              aria-expanded={inspectorOpen}
              onClick={() => setInspectorOpen((value) => !value)}
            >
              <PanelRight size={17} />
            </Button>
          </div>
        </header>
        {history ? (
          <section className="task-view" aria-label={t('Task history')}>
            <div className="task-heading">
              <h2>{t('Task history')}</h2>
              <Button onClick={() => newTask()}>{t('New task')}</Button>
              <Button
                variant="outline"
                onClick={() =>
                  void perform(async () => {
                    const task = await api().agent.import();
                    if (task) {
                      await useStore.getState().refresh();
                      useStore.setState({ activeId: task.id });
                      setHistory(false);
                    }
                  })
                }
              >
                {t('Import conversation')}
              </Button>
            </div>
            <p className="muted">
              {t('{count} tasks · Search with the sidebar field.', { count: filteredTasks.length })}
            </p>
            <label>
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              {t('Show archived tasks')}
            </label>
            {filteredTasks.map((task) => (
              <button
                key={task.id}
                className="history-row"
                onClick={() => {
                  setHistory(false);
                  useStore.setState({ activeId: task.id });
                }}
              >
                <strong>{task.title}</strong>
                <span>
                  {task.demo ? `${t('Demo')} · ` : ''}
                  {t(`status.${task.status}`)} · {new Date(task.createdAt).toLocaleString(locale)}
                </span>
              </button>
            ))}
            {filteredTasks.length === 0 && (
              <p className="muted">
                {t('No matching tasks. Start a new task or clear the search.')}
              </p>
            )}
          </section>
        ) : active ? (
          <section
            className="task-view conversation-view"
            aria-label={t('Active task')}
            data-task-id={active.id}
          >
            <div className="task-heading">
              <h2>
                {active.title}
                <span className="task-mode">
                  {t(active.runOptions?.mode === 'plan' ? 'Plan' : 'Execute')}
                </span>
              </h2>
              <div className="actions">
                <Button
                  variant="ghost"
                  aria-label={t('Pause task')}
                  disabled={terminal || active.status === 'paused' || pausePending || controlling}
                  onClick={() => void control('pause')}
                >
                  <Pause size={14} />
                </Button>
                <Button
                  variant="ghost"
                  aria-label={t('Resume task')}
                  disabled={
                    terminal ||
                    (!pausePending && !['paused', 'interrupted'].includes(active.status)) ||
                    controlling
                  }
                  onClick={() => void control('resume')}
                >
                  <Play size={14} />
                </Button>
                <Button
                  variant="ghost"
                  aria-label={t('Cancel task')}
                  disabled={terminal || controlling}
                  onClick={() => void control('cancel')}
                >
                  <Square size={14} />
                </Button>
                <Button
                  variant="outline"
                  disabled={!terminal || controlling || starting}
                  onClick={() => void control('retry')}
                >
                  {t('Retry')}
                </Button>
              </div>
            </div>
            <TaskActions task={active} />
            <WorktreeActions task={active} />
            {active.modelIdentity && (
              <p className="muted">
                {active.modelIdentity.provider} · {active.modelIdentity.model}
              </p>
            )}
            {active.parentTaskId && (
              <Button
                variant="ghost"
                onClick={() => useStore.setState({ activeId: active.parentTaskId! })}
              >
                {t('Previous turn')}
              </Button>
            )}
            {active.imported && (
              <p className="demo-banner">
                {t(
                  'Imported conversation · previous answers are reference data. Attachments, tool execution, approvals and verification are not restored. Inspect your local workspace before continuing.',
                )}
              </p>
            )}
            {active.demo && (
              <p className="demo-banner">
                {t(
                  'Offline simulation · Sample data and scripted answers. No model requests, local file edits or real tests.',
                )}
              </p>
            )}
            {pausePending && active.status !== 'paused' && (
              <p role="status" className="muted">
                {t('Pause requested · waiting for a safe boundary. Resume clears this request.')}
              </p>
            )}
            <div className="user-prompt">{active.prompt}</div>
            <AttachmentList key={active.id} files={active.attachments ?? []} />
            {active.chat && (
              <div className="workspace-handoff">
                <p className="muted">
                  {t(
                    'Conversation only · open a workspace and start a new task for project tools.',
                  )}
                </p>
                {workspace && (
                  <Button variant="outline" onClick={() => newTask()}>
                    {t('New task in {name}', { name: workspace.name })}
                  </Button>
                )}
              </div>
            )}
            <UserInput task={active} />
            <TaskProgress
              task={active}
              events={visibleEvents}
              onReview={() => showPanel('diff')}
              onExecutePlan={() => {
                setMode('execute');
                setPrompt(
                  t(
                    'Implement the plan from the previous turn. Inspect the current files first, preserve existing changes, run the relevant tests and report actual validation results.',
                  ),
                );
              }}
            />
            {!terminal && (
              <section aria-label={t('Live response')} className="live-response">
                <strong>{active.status === 'paused' ? t('Paused') : t('Working…')}</strong>
                <Answer text={liveText || t('Preparing the next step…')} copy={false} />
              </section>
            )}
            <Timeline events={visibleEvents} />
          </section>
        ) : (
          <section className="welcome">
            <div className="welcome-content">
              <h1>{t('What would you like to work on?')}</h1>
              {composer}
              <div className="suggestions">
                {[
                  [
                    FileCode2,
                    t('Understand a codebase'),
                    t('Map the architecture and find your way in.'),
                    t('Analyze this repository. Explain its architecture and key entry points.'),
                  ],
                  [
                    GitBranch,
                    t('Make a change'),
                    t('Turn an idea into a thoughtful implementation.'),
                    t('Inspect this repository and help me implement the following change:'),
                  ],
                  [
                    Terminal,
                    t('Find and fix an issue'),
                    t('Trace the problem. Test the solution.'),
                    t('Inspect this repository, run its tests, and fix the first failing test.'),
                  ],
                ].map(([Icon, title, , suggestion]) => {
                  const I = Icon as typeof FileCode2;
                  return (
                    <button
                      key={String(title)}
                      onClick={() => {
                        setPrompt(
                          simulated
                            ? String(title) === t('Understand a codebase')
                              ? t('Analyze the sample project architecture and propose a plan.')
                              : String(title) === t('Make a change')
                                ? t('Fix the sample shopping cart calculation and show the diff.')
                                : t('Fix the sample tests and explain the simulated results.')
                            : String(suggestion),
                        );
                        setMode(title === t('Understand a codebase') ? 'plan' : 'execute');
                        promptRef.current?.focus();
                        promptRef.current?.scrollIntoView({ block: 'nearest' });
                      }}
                      className="suggestion"
                    >
                      <I size={19} />
                      <strong>{String(title)}</strong>

                      <ArrowUpRight size={15} />
                    </button>
                  );
                })}
              </div>
              {simulated && (
                <div className="demo-banner">
                  {t(
                    'Try offline Q&A without configuring a model. Ask about the sample architecture or fix its tests. Suggestions fill your draft; send to start.',
                  )}
                </div>
              )}
            </div>
          </section>
        )}
        {active && !history && <div className="follow-up-composer">{composer}</div>}
        {notice && (
          <div role="status" className="notice">
            {notice}
          </div>
        )}
        {error && (
          <div role="alert" className="error global-error">
            {error}
            <button onClick={() => useStore.setState({ error: '' })}>{t('Dismiss')}</button>
          </div>
        )}
      </main>
      {inspectorOpen && (
        <button
          aria-label={t('Close right panel overlay')}
          className="inspector-shade"
          onClick={() => setInspectorOpen(false)}
        />
      )}
      <aside className="inspector" aria-label={t('Right panel')} aria-hidden={!inspectorOpen}>
        <div className="inspector-header">
          <strong>{t(tab)}</strong>
          <button
            className="icon-button"
            aria-label={t('Close panel')}
            onClick={() => setInspectorOpen(false)}
          >
            <X size={16} />
          </button>
        </div>
        <div className="inspector-body">
          {tab === 'browser' ? (
            activeId ? (
              <BrowserPanel key={activeId} taskId={activeId} />
            ) : (
              <p className="muted">{t('Select a task to see its browser.')}</p>
            )
          ) : tab === 'terminal' ? (
            active?.demo ? (
              <p className="muted">
                {t(
                  'Demo mode does not run a shell. Connect a model and select a workspace to open a real terminal.',
                )}
              </p>
            ) : (
              <TerminalPanel key={activeId ?? workspace?.root} taskId={activeId ?? undefined} />
            )
          ) : tab === 'diff' ? (
            activeId ? (
              <ChangesPanel key={activeId} taskId={activeId} />
            ) : (
              <p className="muted">{t('Select a task to review its changes.')}</p>
            )
          ) : (
            <>
              <div className="file-heading">
                {t('FILES')}
                <span className="spacer" />
                {browsing?.files.length ?? 0}
              </div>
              {active?.demo && <p className="muted">{t('Sample files · simulated')}</p>}
              {loadingFiles ? (
                <p className="muted" role="status">
                  {t('Loading files…')}
                </p>
              ) : file ? (
                <>
                  <Button variant="ghost" onClick={() => setFile(undefined)}>
                    ← {t('Files')} · {file.name}
                  </Button>
                  <CodePanel content={file.content} />
                </>
              ) : browsing ? (
                <FileTree
                  key={browsing.root}
                  files={browsing.files}
                  onOpen={(name) => {
                    const request = ++fileRequest.current;
                    setLoadingFiles(true);
                    void perform(async () => {
                      const content = await api().workspace.read(name, activeId ?? undefined);
                      if (request === fileRequest.current) {
                        setFile({ name, content });
                        setLoadingFiles(false);
                      }
                    }).finally(() => {
                      if (request === fileRequest.current) setLoadingFiles(false);
                    });
                  }}
                />
              ) : (
                <div className="inspector-empty">
                  <FolderOpen size={28} />
                  <h3>{t('A place to build')}</h3>
                  <p>
                    {t(
                      'Connect a local repository to browse files, review changes, and follow your agent’s work.',
                    )}
                  </p>
                  <Button variant="outline" onClick={() => void open()}>
                    {t('Open folder')}
                    <ArrowUpRight size={13} />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
      {taskOptions && (
        <TaskOptions
          close={() => setTaskOptions(false)}
          mode={mode}
          setMode={(value) => {
            setMode(value);
            if (value === 'plan') setIsolated(false);
          }}
          maxSteps={maxSteps}
          setMaxSteps={setMaxSteps}
          isolated={isolated}
          setIsolated={setIsolated}
          canIsolate={!active && mode !== 'plan' && !simulated && !!workspace}
          followUp={!!active}
          value={runSettings}
          onChange={setRunSettings}
        />
      )}
      {appearance && <AppearanceSettings close={() => setAppearance(false)} />}
      {workspaceSettings && (
        <WorkspaceSettings close={() => setWorkspaceSettings(null)} project={workspaceSettings} />
      )}
      {dataSettings && <WorkspaceSettings close={() => setDataSettings(false)} />}
      {syncSettings && (
        <Dialog
          title={t('Account & sync')}
          close={() => setSyncSettings(false)}
          className="sync-dialog"
        >
          <SyncPanel />
        </Dialog>
      )}
      {settings && <ModelSettings close={() => setSettings(false)} />}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
