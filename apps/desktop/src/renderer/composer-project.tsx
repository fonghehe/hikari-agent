import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, FolderOpen, Plus, Search, X } from 'lucide-react';
import type { WorkspaceProject } from '@hikari/shared';
import { api, useStore } from './store';
import { useI18n, localizedError } from './i18n';
import { projectDisplayNames } from './project-navigation';
import { ProjectDialog } from './project-dialog';
import './composer-project.css';

export function ComposerProject({
  locked,
  label,
  title,
  changed,
}: {
  locked: boolean;
  label?: string;
  title?: string;
  changed(): void;
}) {
  const { t } = useI18n();
  const { workspace, opening, starting, projectsRevision } = useStore();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const disabled = opening || starting;
  const names = projectDisplayNames(projects);
  const visible = projects.filter((project) =>
    `${project.name} ${project.root}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    void api()
      .workspace.recent()
      .then(
        (items) => {
          if (!cancelled) {
            setProjects(items.filter((project) => !project.hidden));
            setLoading(false);
          }
        },
        (reason) => {
          if (!cancelled) {
            setError(localizedError(reason));
            setLoading(false);
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [expanded, projectsRevision]);
  useLayoutEffect(() => {
    if (!expanded) return;
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const popup = panel.current;
      if (!anchor || !popup) return;
      const height = popup.getBoundingClientRect().height;
      popup.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - popup.offsetWidth - 8))}px`;
      popup.style.top = `${Math.max(8, Math.min(anchor.top - height - 8, innerHeight - height - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [expanded]);
  useEffect(() => {
    if (locked || disabled) panel.current?.hidePopover();
  }, [locked, disabled]);
  const select = async (root: string | null) => {
    panel.current?.hidePopover();
    if (await useStore.getState().selectWorkspace(root)) changed();
  };
  if (locked)
    return (
      <span className="composer-workspace" title={title}>
        <FolderOpen size={14} />
        <span>{label}</span>
      </span>
    );
  return (
    <>
      <div className={`composer-project ${workspace ? 'has-project' : ''}`}>
        {workspace && (
          <button
            type="button"
            className="composer-project-clear"
            disabled={disabled}
            aria-label={t('Clear project selection')}
            title={t('Clear project selection')}
            onClick={() => void select(null)}
          >
            <X size={12} />
          </button>
        )}
        <button
          ref={trigger}
          type="button"
          className="composer-project-trigger"
          aria-label={t(workspace ? 'Change project' : 'Select project')}
          aria-haspopup="dialog"
          aria-expanded={expanded}
          aria-controls={id}
          title={workspace?.root ?? t('Select project')}
          disabled={disabled}
          popoverTarget={id}
        >
          {!workspace && <FolderOpen size={15} />}
          <span>{opening ? t('Opening…') : (workspace?.name ?? t('Select project'))}</span>
        </button>
      </div>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={t('Select project')}
        className="composer-project-picker"
        onToggle={(event) => {
          const open = event.newState === 'open';
          setExpanded(open);
          if (open) {
            setQuery('');
            search.current?.focus();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            return;
          }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          if (event.target === search.current && !['ArrowDown', 'ArrowUp'].includes(event.key))
            return;
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
          );
          if (!buttons.length) return;
          event.preventDefault();
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : event.key === 'ArrowDown'
                  ? (index + 1) % buttons.length
                  : index <= 0
                    ? buttons.length - 1
                    : index - 1;
          buttons[next]?.focus();
        }}
      >
        <label className="composer-project-search">
          <Search size={16} />
          <input
            ref={search}
            aria-label={t('Search projects')}
            placeholder={t('Search projects')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter in this search field must never submit the conversation.
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
        </label>
        <div className="composer-project-results" aria-busy={loading}>
          {error ? (
            <p role="alert">{error}</p>
          ) : loading ? (
            <p role="status">{t('Loading…')}</p>
          ) : visible.length ? (
            visible.map((project) => {
              const name = names.get(project.root) ?? project.name;
              const selected = workspace?.root === project.root;
              return (
                <button
                  type="button"
                  key={project.root}
                  aria-label={name}
                  aria-pressed={selected}
                  title={project.root}
                  disabled={disabled}
                  onClick={() => void select(project.root)}
                >
                  <FolderOpen size={17} />
                  <span className="composer-project-name">{project.name}</span>
                  {name !== project.name && <small>{name.slice(project.name.length + 3)}</small>}
                  {selected && <Check size={15} className="composer-project-check" />}
                </button>
              );
            })
          ) : (
            <p role="status">{t('No projects found')}</p>
          )}
        </div>
        <button
          type="button"
          className="composer-project-create"
          disabled={disabled}
          onClick={() => {
            panel.current?.hidePopover();
            setCreating(true);
          }}
        >
          <Plus size={17} />
          <span>{t('New project')}</span>
        </button>
      </div>
      {creating && <ProjectDialog close={() => setCreating(false)} created={changed} />}
    </>
  );
}
