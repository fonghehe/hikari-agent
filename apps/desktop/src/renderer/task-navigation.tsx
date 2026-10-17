import { useEffect, useState, useRef } from 'react';
import {
  FolderOpen,
  Plus,
  History,
  SquarePen,
  ChevronRight,
  Ellipsis,
  PanelLeft,
  ArrowDownUp,
  Folder,
  List,
} from 'lucide-react';
import type { Task } from '@hikari/agent-core';
import type { WorkspaceProject } from '@hikari/shared';
import {
  groupProjectTasks,
  sortNavigationTasks,
  moveNavigationTask,
  projectDisplayNames,
  type ProjectTaskGroup,
} from './project-navigation';
import { api, perform, useStore } from './store';
import { useI18n } from './i18n';
import { ProjectDialog } from './project-dialog';
import { ProjectMenu, type ProjectMenuAction } from './project-menu';
import { ProjectSectionDialog } from './project-section-dialog';
import { ProjectRemovalDialog } from './project-removal-dialog';
import { ConversationMenu } from './conversation-menu';
import { SectionMenu } from './section-menu';
import { ContextMenu } from './context-menu';

function savedOption(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`hikari:${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

export function TaskNavigation({
  tasks,
  search,
  select,
  create,
  history,
  historyActive,
}: {
  tasks: Task[];
  search: string;
  select(task: Task): void;
  create(section?: string): void;
  history(): void;
  historyActive: boolean;
}) {
  const { t } = useI18n();
  const { workspace, activeId, opening, starting, projectsRevision } = useStore();
  const [sectionMenu, setSectionMenu] = useState<{
    name: string;
    x: number;
    y: number;
    unread: boolean;
    hasTasks: boolean;
    active: boolean;
  } | null>(null);
  const [listMenu, setListMenu] = useState<{ x: number; y: number } | null>(null);
  const [sortOrder, setSortOrder] = useState(() => savedOption('chat-sort', 'updated'));
  const [grouping, setGrouping] = useState(() => savedOption('sidebar-grouping', 'projects'));
  const grouped = grouping !== 'merged';
  const [manualOrder, setManualOrder] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(savedOption('chat-manual-order', '[]'));
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  });
  const draggedTask = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const saveOption = (key: string, value: string) => {
    try {
      localStorage.setItem(`hikari:${key}`, value);
    } catch {
      /* Keep navigation usable. */
    }
  };
  const [registeredSections, setRegisteredSections] = useState<string[]>([]);
  const [recent, setRecent] = useState<WorkspaceProject[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('hikari:collapsed-sections') ?? '[]');
      return new Set(
        Array.isArray(saved)
          ? saved.filter((item): item is string => typeof item === 'string')
          : [],
      );
    } catch {
      return new Set();
    }
  });
  const toggleSection = (section: string) =>
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      try {
        localStorage.setItem('hikari:collapsed-sections', JSON.stringify([...next]));
      } catch {
        /* Navigation remains usable if local storage is unavailable. */
      }
      return next;
    });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<{ project: ProjectTaskGroup; x: number; y: number } | null>(
    null,
  );
  const [taskMenu, setTaskMenu] = useState<{ task: Task; x: number; y: number } | null>(null);
  const [sectionProject, setSectionProject] = useState<WorkspaceProject | null>(null);
  const [removingProject, setRemovingProject] = useState<WorkspaceProject | null>(null);
  const [editing, setEditing] = useState<WorkspaceProject | 'new' | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api().workspace.recent(), api().sections.list()])
      .then(([items, sectionNames]) => {
        if (!cancelled) {
          setRecent(items);
          setRegisteredSections(sectionNames);
          setLoaded(true);
        }
      })
      .catch((error) => {
        if (!cancelled) useStore.setState({ error: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [workspace?.root, projectsRevision]);
  const known =
    workspace && !recent.some((item) => item.root === workspace.root)
      ? [workspace, ...recent.filter((item) => item.root !== workspace.root)]
      : recent;
  const hiddenRoots = new Set(
    recent
      .filter((project) => project.hidden)
      .flatMap((project) => [project.root, ...(project.aliases ?? [])]),
  );
  const availableTasks = sortNavigationTasks(
    tasks.filter((task) => task.chat || task.demo || !hiddenRoots.has(task.workspace)),
    sortOrder === 'manual' ? manualOrder : undefined,
  );
  const saveManualOrder = (order: string[]) => {
    setManualOrder(order);
    saveOption('chat-manual-order', JSON.stringify(order));
  };
  const moveTask = (id: string, target: string, after = false) => {
    const order = sortNavigationTasks(useStore.getState().tasks, manualOrder).map(
      (task) => task.id,
    );
    saveManualOrder(moveNavigationTask(order, id, target, after));
  };
  const ordered = (items: Task[]) =>
    sortNavigationTasks(items, sortOrder === 'manual' ? manualOrder : undefined);
  const arranged = availableTasks.filter(
    (task) => task.navigation?.pinned || task.navigation?.section,
  );
  const groups = groupProjectTasks(
    availableTasks.filter((task) => !arranged.includes(task)),
    known,
  );
  const names = projectDisplayNames(groups.projects);
  const sections = [
    ...new Set([
      ...registeredSections,
      ...arranged
        .map((task) => task.navigation?.section)
        .filter((section): section is string => !!section),
      ...recent
        .filter((project) => !project.hidden && project.section)
        .map((project) => project.section!),
    ]),
  ];
  const projectAction = async (project: WorkspaceProject, action: ProjectMenuAction) => {
    if (action.type === 'edit') {
      setEditing(project);
      return;
    }
    if (action.type === 'newSection') {
      setSectionProject(project);
      return;
    }
    if (action.type === 'remove') {
      setRemovingProject(project);
      return;
    }
    await perform(async () => {
      if (action.type === 'pin')
        await api().workspace.organize(project.root, { pinned: !project.pinned });
      if (action.type === 'section')
        await api().workspace.organize(project.root, { section: action.section });
      if (action.type === 'archive') {
        await api().workspace.archive(project.root);
        await useStore.getState().refresh();
      }
      useStore.setState((state) => ({ projectsRevision: state.projectsRevision + 1 }));
    });
  };
  const active = tasks.find((task) => task.id === activeId);
  const selectedRoot = active
    ? !active.chat && !active.demo
      ? active.workspace
      : undefined
    : workspace?.root;
  const start = async (root: string | null, section?: string) => {
    if (await useStore.getState().selectWorkspace(root)) create(section);
  };
  const renderTask = (task: Task) => (
    <button
      className={`task-button ${activeId === task.id ? 'selected' : ''}`}
      key={task.id}
      aria-current={activeId === task.id ? 'page' : undefined}
      data-unread={!!task.navigation?.unread}
      data-task-id={task.id}
      data-drop-target={dropTarget === task.id || undefined}
      draggable={sortOrder === 'manual'}
      title={sortOrder === 'manual' ? t('Drag to reorder, or use Alt + Up/Down') : undefined}
      onDragStart={(event) => {
        if (sortOrder !== 'manual') return;
        draggedTask.current = task.id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', task.id);
      }}
      onDragOver={(event) => {
        if (sortOrder !== 'manual' || !draggedTask.current || draggedTask.current === task.id)
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropTarget(task.id);
      }}
      onDragLeave={() => setDropTarget(null)}
      onDrop={(event) => {
        event.preventDefault();
        if (sortOrder === 'manual' && draggedTask.current) {
          const bounds = event.currentTarget.getBoundingClientRect();
          moveTask(draggedTask.current, task.id, event.clientY > bounds.top + bounds.height / 2);
        }
        draggedTask.current = null;
        setDropTarget(null);
      }}
      onDragEnd={() => {
        draggedTask.current = null;
        setDropTarget(null);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.currentTarget.focus();
        setTaskMenu({ task, x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (
          sortOrder === 'manual' &&
          event.altKey &&
          ['ArrowUp', 'ArrowDown'].includes(event.key)
        ) {
          event.preventDefault();
          const siblings = [
            ...event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
              ':scope > .task-button',
            ),
          ];
          const index = siblings.indexOf(event.currentTarget);
          const target = siblings[index + (event.key === 'ArrowUp' ? -1 : 1)]?.dataset.taskId;
          if (target) moveTask(task.id, target, event.key === 'ArrowDown');
          return;
        }
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          setTaskMenu({ task, x: bounds.left + 24, y: bounds.bottom });
        }
      }}
      onClick={() => {
        if (task.navigation?.unread)
          void perform(async () => {
            await api().agent.organize(task.id, { unread: false });
            await useStore.getState().refresh();
          });
        select(task);
      }}
    >
      <span className="task-title">{task.title}</span>
      <span
        className="task-state"
        data-status={task.status}
        role="img"
        aria-label={t(`status.${task.status}`)}
        title={t(`status.${task.status}`)}
      />
    </button>
  );
  const visibleProjects = groups.projects.filter(
    (group) =>
      loaded &&
      (!search ||
        group.tasks.length ||
        `${group.name} ${group.root}`.toLowerCase().includes(search.toLowerCase())),
  );
  const renderProject = (group: ProjectTaskGroup) => {
    const label = names.get(group.root) ?? group.name;
    const expanded = !!search || !collapsed.has(group.root);
    const selected =
      !!selectedRoot && (selectedRoot === group.root || !!group.aliases?.includes(selectedRoot));
    const showMenu = (element: HTMLElement, x: number, y: number) => {
      element.querySelector<HTMLButtonElement>('.project-select')?.focus();
      setMenu({ project: group, x, y });
    };
    return (
      <section className="project-group" key={group.root} aria-label={group.root}>
        <div
          className={`project-row ${selected ? 'active' : ''}`}
          onContextMenu={(event) => {
            event.preventDefault();
            if (!opening && !starting) showMenu(event.currentTarget, event.clientX, event.clientY);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault();
              const bounds = event.currentTarget.getBoundingClientRect();
              showMenu(event.currentTarget, bounds.left + 24, bounds.bottom);
            }
          }}
        >
          <button
            className="project-select"
            title={group.root}
            disabled={opening || starting}
            aria-label={t('Open project {name}', { name: label })}
            aria-expanded={expanded}
            aria-current={selected ? 'true' : undefined}
            onClick={() =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(group.root)) next.delete(group.root);
                else next.add(group.root);
                return next;
              })
            }
          >
            <span className="project-folder">
              <FolderOpen size={16} />
              <ChevronRight size={13} className={expanded ? 'expanded' : ''} />
            </span>
            <span className="project-label">
              <span>{group.name}</span>
              {label !== group.name && (
                <small className="project-location">{label.slice(group.name.length + 3)}</small>
              )}
            </span>
          </button>
          <button
            className="history-entry project-create"
            disabled={opening || starting}
            aria-label={t('New task in {name}', { name: label })}
            title={t('New task in {name}', { name: label })}
            onClick={() => void start(group.root)}
          >
            <SquarePen size={16} />
          </button>
        </div>
        {expanded && <div className="project-tasks">{group.tasks.map(renderTask)}</div>}
      </section>
    );
  };
  const renderChats = () => (
    <section className="chat-group" aria-label={t('Recent')}>
      <div className="sidebar-section-heading">
        <span>{t('Recent')}</span>
        <div className="sidebar-section-actions">
          <button
            className={`history-entry ${historyActive ? 'active' : ''}`}
            aria-label={t('Task history')}
            title={t('Task history')}
            onClick={history}
          >
            <History size={14} />
          </button>
          <button
            className="history-entry"
            aria-label={t('New chat')}
            title={t('New chat')}
            disabled={opening || starting}
            onClick={() => void start(null)}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
      {groups.chats.map(renderTask)}
    </section>
  );
  return (
    <nav className="task-list" aria-label={t('Conversations and projects')}>
      {sections.map((section) => {
        const projects = visibleProjects.filter(
          (project) => !project.pinned && project.section === section,
        );
        const sectionTasks = arranged.filter(
          (task) => !task.navigation?.pinned && task.navigation?.section === section,
        );
        return (
          <section className="custom-section" key={section} aria-label={section}>
            <div
              className="sidebar-section-heading section-heading"
              onContextMenu={(event) => {
                event.preventDefault();
                event.currentTarget.querySelector('button')?.focus();
                const members = [...sectionTasks, ...projects.flatMap((project) => project.tasks)];
                setSectionMenu({
                  name: section,
                  x: event.clientX,
                  y: event.clientY,
                  unread: members.some((task) => !!task.navigation?.unread),
                  hasTasks: !!members.length,
                  active: members.some(
                    (task) =>
                      !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status),
                  ),
                });
              }}
            >
              <button
                className="section-toggle"
                aria-label={t('Toggle section {name}', { name: section })}
                aria-expanded={!!search || !collapsedSections.has(section)}
                aria-controls={`section-content-${encodeURIComponent(section)}`}
                onClick={() => toggleSection(section)}
              >
                <ChevronRight
                  size={13}
                  className={!!search || !collapsedSections.has(section) ? 'expanded' : ''}
                />
                <span>{section}</span>
              </button>
              <div className="sidebar-section-actions">
                <button
                  className="history-entry"
                  aria-label={t('Manage section {name}', { name: section })}
                  onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const members = [
                      ...sectionTasks,
                      ...projects.flatMap((project) => project.tasks),
                    ];
                    setSectionMenu({
                      name: section,
                      x: bounds.left,
                      y: bounds.bottom,
                      unread: members.some((task) => !!task.navigation?.unread),
                      hasTasks: !!members.length,
                      active: members.some(
                        (task) =>
                          !['completed', 'failed', 'cancelled', 'interrupted'].includes(
                            task.status,
                          ),
                      ),
                    });
                  }}
                >
                  <Ellipsis size={14} />
                </button>
                <button
                  className="history-entry"
                  disabled={opening || starting}
                  aria-label={t('New chat in section {name}', { name: section })}
                  title={t('New chat in section {name}', { name: section })}
                  onClick={() => {
                    setCollapsedSections((current) => {
                      const next = new Set(current);
                      next.delete(section);
                      try {
                        localStorage.setItem(
                          'hikari:collapsed-sections',
                          JSON.stringify([...next]),
                        );
                      } catch {
                        /* Keep navigation usable. */
                      }
                      return next;
                    });
                    void start(null, section);
                  }}
                >
                  <SquarePen size={14} />
                </button>
              </div>
            </div>
            <div
              id={`section-content-${encodeURIComponent(section)}`}
              className="section-content"
              hidden={!search && collapsedSections.has(section)}
            >
              {grouped ? (
                <>
                  {projects.map(renderProject)}
                  {sectionTasks.map(renderTask)}
                </>
              ) : (
                ordered([...projects.flatMap((project) => project.tasks), ...sectionTasks]).map(
                  renderTask,
                )
              )}
            </div>
          </section>
        );
      })}

      {(visibleProjects.some((project) => project.pinned) ||
        arranged.some((task) => task.navigation?.pinned)) && (
        <section aria-label={t('Pinned')}>
          <div className="sidebar-section-heading">
            <span>{t('Pinned')}</span>
          </div>
          {grouped ? (
            <>
              {visibleProjects.filter((project) => project.pinned).map(renderProject)}
              {arranged.filter((task) => task.navigation?.pinned).map(renderTask)}
            </>
          ) : (
            ordered([
              ...visibleProjects
                .filter((project) => project.pinned)
                .flatMap((project) => project.tasks),
              ...arranged.filter((task) => task.navigation?.pinned),
            ]).map(renderTask)
          )}
        </section>
      )}
      <section className="projects-section" aria-label={t(grouped ? 'Projects' : 'Chats')}>
        <div className="sidebar-section-heading">
          <button
            className="section-toggle"
            aria-label={t(grouped ? 'Toggle projects' : 'Toggle chats')}
            aria-expanded={!!search || !collapsedSections.has('hikari:projects')}
            aria-controls="sidebar-projects"
            onClick={() => toggleSection('hikari:projects')}
          >
            <span>{t(grouped ? 'Projects' : 'Chats')}</span>
            <ChevronRight
              size={13}
              className={!!search || !collapsedSections.has('hikari:projects') ? 'expanded' : ''}
            />
          </button>
          <div className="sidebar-section-actions">
            <button
              className="history-entry"
              aria-label={t('Project list options')}
              title={t('Project list options')}
              aria-haspopup="menu"
              aria-expanded={!!listMenu}
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                setListMenu(listMenu ? null : { x: bounds.left, y: bounds.bottom + 4 });
              }}
            >
              <Ellipsis size={16} />
            </button>
            <button
              className="history-entry"
              aria-label={t('Add project')}
              title={t('Add project')}
              disabled={opening || starting}
              onClick={() => setEditing('new')}
            >
              <Plus size={16} />
            </button>
          </div>
        </div>
        <div id="sidebar-projects" hidden={!search && collapsedSections.has('hikari:projects')}>
          {grouped ? (
            visibleProjects
              .filter((project) => !project.pinned && !project.section)
              .map(renderProject)
          ) : (
            <div className="merged-tasks">
              {ordered([
                ...groups.chats,
                ...visibleProjects
                  .filter((project) => !project.pinned && !project.section)
                  .flatMap((project) => project.tasks),
              ]).map(renderTask)}
            </div>
          )}
        </div>
      </section>
      {grouped ? (
        renderChats()
      ) : (
        <button className="merged-history-entry" onClick={history}>
          <History size={14} />
          {t('Task history')}
        </button>
      )}
      {listMenu && (
        <ContextMenu
          label={t('Project list options')}
          className="project-list-menu"
          x={listMenu.x}
          y={listMenu.y}
          close={() => setListMenu(null)}
          items={[
            {
              id: 'organize',
              label: t('Organize sidebar'),
              icon: <PanelLeft />,
              children: [
                {
                  id: 'projects',
                  label: t('By project'),
                  icon: <Folder />,
                  checked: grouped,
                  run: () => {
                    setGrouping('projects');
                    saveOption('sidebar-grouping', 'projects');
                  },
                },
                {
                  id: 'merged',
                  label: t('Combined view'),
                  icon: <List />,
                  checked: !grouped,
                  run: () => {
                    setGrouping('merged');
                    saveOption('sidebar-grouping', 'merged');
                  },
                },
              ],
            },
            {
              id: 'sort',
              label: t('Chat sort order'),
              icon: <ArrowDownUp />,
              children: [
                {
                  id: 'updated',
                  label: t('Recently updated'),
                  checked: sortOrder !== 'manual',
                  run: () => {
                    setSortOrder('updated');
                    saveOption('chat-sort', 'updated');
                  },
                },
                {
                  id: 'manual',
                  label: t('Manual order'),
                  checked: sortOrder === 'manual',
                  run: () => {
                    if (sortOrder !== 'manual' && !manualOrder.length) {
                      saveManualOrder(
                        sortNavigationTasks(useStore.getState().tasks).map((task) => task.id),
                      );
                    }
                    setSortOrder('manual');
                    saveOption('chat-sort', 'manual');
                  },
                },
              ],
            },
          ]}
        />
      )}
      {!tasks.length && !search && (
        <p className="sidebar-empty">
          {t('Your work starts here.')}
          <br />
          {t('Try demo Q&A or open a repository.')}
        </p>
      )}
      <SectionMenu menu={sectionMenu} close={() => setSectionMenu(null)} />
      <ConversationMenu
        menu={taskMenu}
        sections={sections}
        close={() => setTaskMenu(null)}
        select={select}
      />
      {menu && (
        <ProjectMenu
          project={menu.project}
          sections={sections}
          x={menu.x}
          y={menu.y}
          close={() => setMenu(null)}
          action={(action) => void projectAction(menu.project, action)}
        />
      )}
      {sectionProject && (
        <ProjectSectionDialog project={sectionProject} close={() => setSectionProject(null)} />
      )}
      {removingProject && (
        <ProjectRemovalDialog project={removingProject} close={() => setRemovingProject(null)} />
      )}
      {editing && (
        <ProjectDialog
          project={editing === 'new' ? undefined : editing}
          close={() => setEditing(null)}
          created={create}
        />
      )}
    </nav>
  );
}
