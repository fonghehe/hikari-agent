import { useEffect, useRef, type ReactNode, type MouseEvent } from 'react';
import {
  ChevronDown,
  Settings2,
  Palette,
  Database,
  Ellipsis,
  FileCode2,
  GitBranch,
  Terminal,
  Globe,
  RefreshCw,
} from 'lucide-react';
import { useStore } from './store';
import { useI18n } from './i18n';

function SidebarMenu({
  trigger,
  children,
  className = '',
  triggerClassName,
  label,
  disabled,
  onTrigger,
}: {
  trigger: ReactNode;
  children(close: () => void): ReactNode;
  className?: string;
  triggerClassName?: string;
  label?: string;
  disabled?: boolean;
  onTrigger?(event: MouseEvent<HTMLElement>): void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const close = () => {
    if (ref.current) ref.current.open = false;
  };
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && ref.current?.open) {
        close();
        ref.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  return (
    <details ref={ref} className={`sidebar-menu ${className}`}>
      <summary
        role="button"
        className={triggerClassName}
        aria-label={label}
        aria-disabled={disabled || undefined}
        onClick={(event) => {
          if (disabled) event.preventDefault();
          else onTrigger?.(event);
        }}
      >
        {trigger}
      </summary>
      <div className="sidebar-menu-content">{children(close)}</div>
    </details>
  );
}

export function SidebarSettings({
  model,
  appearance,
  data,
  sync,
}: {
  model(): void;
  appearance(): void;
  data(): void;
  sync(): void;
}) {
  const { t } = useI18n();
  const configured = useStore((state) => state.configured);
  return (
    <SidebarMenu
      className="sidebar-settings"
      label={t('Settings')}
      trigger={
        <>
          <Settings2 size={17} />
          <span>
            {t('Settings')}
            <small>{t(configured ? 'Model connected' : 'Demo mode · offline')}</small>
          </span>
          <ChevronDown size={14} />
        </>
      }
    >
      {(close) => (
        <>
          {[
            { Icon: Settings2, label: 'Model settings', action: model },
            { Icon: Palette, label: 'Appearance & language', action: appearance },
            { Icon: Database, label: 'Data & updates', action: data },
            { Icon: RefreshCw, label: 'Account & sync', action: sync },
          ].map(({ Icon, label, action }) => (
            <button
              key={label}
              onClick={() => {
                close();
                action();
              }}
            >
              <Icon size={16} />
              {t(label)}
            </button>
          ))}
        </>
      )}
    </SidebarMenu>
  );
}

export function WorkspaceTools({
  open,
}: {
  open(name: 'files' | 'diff' | 'terminal' | 'browser'): void;
}) {
  const { t } = useI18n();
  return (
    <SidebarMenu
      className="workspace-tools"
      label={t('Workspace tools')}
      trigger={<Ellipsis size={18} />}
    >
      {(close) => (
        <>
          {(
            [
              ['files', FileCode2],
              ['diff', GitBranch],
              ['terminal', Terminal],
              ['browser', Globe],
            ] as const
          ).map(([name, Icon]) => (
            <button
              key={name}
              onClick={() => {
                close();
                open(name);
              }}
            >
              <Icon size={16} />
              {t(name)}
            </button>
          ))}
        </>
      )}
    </SidebarMenu>
  );
}
