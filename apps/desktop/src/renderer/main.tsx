import { TaskActions, WorktreeActions, RecentWorkspaces } from './task-actions';
import { WorkspaceSettings } from './workspace-settings';
import { RunSettings, UserInput } from './run-settings';
import type { RunOptions } from '@hikari/agent-core';
import { useI18n } from './i18n';
import { Answer } from './answer';
import { AttachButton, AttachmentList, useComposerDraft } from './attachments';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowUp,
  FolderOpen,
  Plus,
  PanelRight,
  GitBranch,
  ChevronRight,
  FileCode2,
  Settings2,
  Terminal,
  Search,
  Layers,
  ArrowUpRight,
  Sparkles,
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
  return (
    <div className="timeline">
      {events
        .filter(
          (e) =>
            ![
              'agent.message.delta',
              'agent.state',
              'tool.stdout',
              'git.diff.updated',
              'plan.updated',
              'agent.run.summary',
            ].includes(e.type),
        )
        .map((event) => {
          const request =
            event.type === 'permission.requested'
              ? (event.data.request as unknown as PermissionRequest)
              : null;
          const settled =
            request &&
            events.some(
              (e) =>
                ['permission.approved', 'permission.denied'].includes(e.type) &&
                e.data.id === request.id,
            );
          const terminal = events.some((e) =>
            ['agent.completed', 'agent.failed', 'agent.cancelled'].includes(e.type),
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
        })}
    </div>
  );
}
function App() {
  const { t, locale } = useI18n();

  const fileRequest = useRef(0);
  const { workspace, error, notice, open, opening, tasks, activeId, events, configured, starting } =
    useStore();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [history, setHistory] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth > 1180);
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
      textarea.style.height = `${Math.max(100, Math.min(260, textarea.scrollHeight))}px`;
    }
  }, [prompt, activeId]);
  const [isolated, setIsolated] = useState(false);
  const [mode, setMode] = useState<'plan' | 'execute'>('execute');
  const [runSettings, setRunSettings] = useState<Partial<RunOptions>>({});
  const [maxSteps, setMaxSteps] = useState(30);
  const [taskSearch, setTaskSearch] = useState('');
  const [settings, setSettings] = useState(false);
  const [workspaceSettings, setWorkspaceSettings] = useState(false);
  const [appearance, setAppearance] = useState(false);
  const [tab, setTab] = useState<'files' | 'diff' | 'terminal' | 'browser' | 'sync'>('files');
  const [file, setFile] = useState<{ name: string; content: string }>();
  const active = tasks.find((t) => t.id === activeId);
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
  const newTask = () => {
    useStore.setState({ activeId: null, error: '', notice: '' });
    draft.clear('new');
    setFile(undefined);
    setHistory(false);
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
        !settings &&
        !appearance
      ) {
        event.preventDefault();
        newTask();
      }
      if (event.key === 'Escape') {
        setSettings(false);
        setAppearance(false);
        setWorkspaceSettings(false);
        if (window.innerWidth <= 1180) setInspectorOpen(false);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [settings, appearance]);
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
          <AttachButton busy={importing || starting} pick={() => void draft.pick()} />
          <Button variant="ghost" disabled={opening} onClick={() => void open()}>
            <FolderOpen size={14} />
            {opening
              ? t('Opening…')
              : (workspace?.name ??
                (simulated ? t('Demo · no workspace needed') : t('Chat · optional workspace')))}
          </Button>
          <span className="spacer" />
          <button
            className="model-label"
            aria-label={configured ? t('Model settings') : t('Configure model')}
            onClick={() => setSettings(true)}
          >
            <Sparkles size={13} />
            {simulated ? t('Demo mode · offline') : t('Model connected')}
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
      <p className="attachment-help">
        {t('Attach, drop or paste · 6 files · 3 images · 10 MB per file')}
      </p>
      {attachments.length > 0 && (
        <p className="attachment-help">
          {t('Attachments go to your connected model. Demo stays offline.')}
        </p>
      )}
      <div className="run-controls">
        <label>
          {active ? t('Next mode') : t('Mode')}{' '}
          <select
            aria-label={t('Agent mode')}
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as 'plan' | 'execute');
              if (event.target.value === 'plan') setIsolated(false);
            }}
          >
            <option value="execute">{t('Execute')}</option>
            <option value="plan">{t('Plan · read only')}</option>
          </select>
        </label>
        <label>
          {t('Max turns')}{' '}
          <input
            aria-label={t('Maximum model turns')}
            type="number"
            min={1}
            max={100}
            value={maxSteps}
            onChange={(event) =>
              setMaxSteps(Math.max(1, Math.min(100, Number(event.target.value) || 1)))
            }
          />
        </label>
        {mode === 'plan' && <span>{t('Reads and planning only')}</span>}
      </div>
      <RunSettings value={runSettings} onChange={setRunSettings} />
      <div className="composer-hint">
        {active ? (
          <span>
            {active.chat
              ? t('Continue this conversation')
              : t('Continue in the same {root}', {
                  root: t(active.worktree ? 'worktree' : 'workspace'),
                })}
          </span>
        ) : (
          <label>
            <input
              type="checkbox"
              disabled={mode === 'plan' || simulated || !workspace}
              checked={isolated}
              onChange={(event) => setIsolated(event.target.checked)}
            />{' '}
            {t('Isolate in a Git worktree')}
          </label>
        )}
        <span>{t('↵ to send')}</span>
      </div>
    </>
  );
  return (
    <div className={`app ${inspectorOpen ? 'panel-open' : 'panel-closed'}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <img src="./hikari-icon.svg" alt="" />
          </span>
          hikari<span className="tag">{t('LOCAL')}</span>
        </div>
        <Button
          variant="outline"
          disabled={opening}
          onClick={() => void open()}
          className="workspace-picker"
        >
          <FolderOpen size={16} />
          <span>{opening ? t('Opening…') : (workspace?.name ?? t('Open workspace'))}</span>
          <ChevronRight size={14} />
        </Button>
        <Button variant="ghost" className="new-task" onClick={newTask}>
          <Plus size={17} />
          {t('New task')}
          <span>⌘ N</span>
        </Button>
        <div className="nav-label">{t('WORKSPACE')}</div>
        <button
          className={`nav-item ${history ? 'active' : ''}`}
          onClick={() => {
            setHistory(true);
            useStore.setState({ activeId: null });
          }}
        >
          <Layers size={16} />
          {t('Tasks')}
          <span className="count">{tasks.length}</span>
        </button>
        <button className="nav-item" onClick={() => showPanel('files')}>
          <Search size={16} />
          {t('Repository')}
        </button>
        <div className="section-title">{t('RECENT TASKS')}</div>
        <input
          className="task-search"
          aria-label={t('Search tasks')}
          placeholder={t('Search task history…')}
          value={taskSearch}
          onChange={(event) => setTaskSearch(event.target.value)}
        />
        <div className="task-list">
          {tasks.length === 0 ? (
            <p className="sidebar-empty">
              {t('Your work starts here.')}
              <br />
              {t('Try demo Q&A or open a repository.')}
            </p>
          ) : (
            filteredTasks.map((task) => (
              <button
                className={`task-button ${activeId === task.id ? 'selected' : ''}`}
                key={task.id}
                onClick={() => {
                  setHistory(false);
                  useStore.setState({ activeId: task.id });
                }}
              >
                <span>{task.title}</span>
                <small>
                  {task.demo ? `${t('Demo')} · ` : ''}
                  {task.runOptions?.mode === 'plan' ? `${t('Plan')} · ` : ''}
                  {t(`status.${task.status}`)}
                </small>
              </button>
            ))
          )}
        </div>
        <button className="appearance-entry" onClick={() => setWorkspaceSettings(true)}>
          <Layers size={16} />
          {t('Memory & extensions')}
        </button>
        <RecentWorkspaces />
        <button
          className="appearance-entry"
          aria-label={t('Appearance & language')}
          onClick={() => setAppearance(true)}
        >
          <Settings2 size={16} />
          {t('Appearance & language')}
        </button>
        <button className="sidebar-bottom" onClick={() => setSettings(true)}>
          <span className="status-dot" />
          {configured ? t('Model connected') : t('Demo mode · model settings')}
          <span className="spacer" />
          <Settings2 size={16} />
        </button>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            {t('Workspace')}
            <ChevronRight size={13} />
            <span>{active?.title ?? t('New task')}</span>
          </div>
          <span className="spacer" />
          <span className="local-pill">
            <span className="status-dot" />
            {active?.status ?? t('On your machine')}
          </span>
          <Button
            variant="ghost"
            aria-label={t('Toggle right panel')}
            aria-expanded={inspectorOpen}
            onClick={() => setInspectorOpen((value) => !value)}
          >
            <PanelRight size={17} />
          </Button>
        </header>
        {history ? (
          <section className="task-view" aria-label={t('Task history')}>
            <div className="task-heading">
              <h2>{t('Task history')}</h2>
              <Button onClick={newTask}>{t('New task')}</Button>
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
          <section className="task-view" aria-label={t('Active task')} data-task-id={active.id}>
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
              <p className="muted">
                {t('Conversation only · open a workspace and start a new task for project tools.')}
              </p>
            )}
            <UserInput task={active} />
            <TaskProgress
              task={active}
              events={visibleEvents}
              onReview={() => showPanel('diff')}
              onExecutePlan={() => {
                setMode('execute');
                setPrompt(
                  'Implement the plan from the previous turn. Inspect the current files first, preserve existing changes, run the relevant tests and report actual validation results.',
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
              <div className="eyebrow">
                <span />
                {t('YOUR IDEAS. IN MOTION.')}
              </div>
              <h1>
                {t('A little direction.')}
                <br />
                <span>{t('A lot of possibility.')}</span>
              </h1>
              <p>
                {t('From first thought to working code.')}
                <br />
                {t('Give your agent a workspace, and something worth building.')}
              </p>
              <div className="suggestions">
                {[
                  [
                    FileCode2,
                    t('Understand a codebase'),
                    t('Map the architecture and find your way in.'),
                    'Analyze this repository. Explain its architecture and key entry points.',
                  ],
                  [
                    GitBranch,
                    t('Make a change'),
                    t('Turn an idea into a thoughtful implementation.'),
                    'Inspect this repository and help me implement ',
                  ],
                  [
                    Terminal,
                    t('Find and fix an issue'),
                    t('Trace the problem. Test the solution.'),
                    'Inspect this repository, run its tests, and fix the first failing test.',
                  ],
                ].map(([Icon, title, description, suggestion]) => {
                  const I = Icon as typeof FileCode2;
                  return (
                    <button
                      key={String(title)}
                      onClick={() => {
                        setPrompt(
                          simulated
                            ? String(title) === t('Understand a codebase')
                              ? '分析示例项目的架构，并给出计划。'
                              : String(title) === t('Make a change')
                                ? '修复示例购物车的金额计算，并演示 Diff。'
                                : '修复示例测试，并说明模拟验证结果。'
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
                      <p>{String(description)}</p>
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
              {composer}
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
        <footer>
          <GitBranch size={12} />
          {simulated
            ? t('Offline simulation · no model required')
            : workspace
              ? t('Workspace connected')
              : t('No repository connected')}
          <span className="spacer" />
          <span>HIKARI / 0.1.0</span>
        </footer>
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
          {(['files', 'diff', 'terminal', 'browser', 'sync'] as const).map((name) => (
            <button
              key={name}
              className={tab === name ? 'tab active-tab' : 'tab'}
              onClick={() => setTab(name)}
              title={t(name)}
            >
              {t(name)}
            </button>
          ))}
        </div>
        <div className="inspector-body">
          {tab === 'sync' ? (
            <SyncPanel />
          ) : tab === 'browser' ? (
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
        <div className="context-note">
          <span className="status-dot" />
          <div>
            <strong>{t('Local by design')}</strong>
            <p>
              {simulated
                ? t('Offline, deterministic examples.')
                : t('Files and tools run locally.')}
              <br />
              {simulated
                ? t('Demo uses only in-memory sample data.')
                : t('Selected context goes to your model.')}
            </p>
          </div>
        </div>
      </aside>
      {appearance && <AppearanceSettings close={() => setAppearance(false)} />}
      {workspaceSettings && (
        <WorkspaceSettings close={() => setWorkspaceSettings(false)} scope={active?.workspace} />
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
