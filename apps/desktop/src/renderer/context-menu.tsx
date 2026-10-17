import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';

export interface MenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  children?: (MenuAction | null)[];
  run?(): void;
}

export function ContextMenu({
  label,
  items,
  x,
  y,
  close,
  className = '',
}: {
  label: string;
  className?: string;
  items: (MenuAction | null)[];
  x: number;
  y: number;
  close(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [keyboardSubmenu, setKeyboardSubmenu] = useState(false);
  const [scrollRevision, setScrollRevision] = useState(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retainSubmenu = () => clearTimeout(closeTimer.current);
  const dismissSubmenu = () => {
    retainSubmenu();
    closeTimer.current = setTimeout(() => setExpanded(null), 180);
  };
  useEffect(() => () => retainSubmenu(), []);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const bounds = root.current!.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(x, innerWidth - bounds.width - 8)),
      y: Math.max(8, Math.min(y, innerHeight - bounds.height - 8)),
    });
    root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [x, y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const resize = () => close();
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', resize);
    };
  }, [close]);
  const render = (actions: (MenuAction | null)[], nested = false) =>
    actions.map((item, index) => {
      if (!item) return <div role="separator" key={`separator-${index}`} />;
      const button = (
        <button
          type="button"
          role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={item.checked}
          disabled={item.disabled}
          className={item.danger ? 'danger' : undefined}
          aria-haspopup={item.children ? 'menu' : undefined}
          aria-expanded={item.children ? expanded === item.id : undefined}
          data-menu-id={item.id}
          onClick={(event) => {
            if (item.children) {
              setKeyboardSubmenu(event.detail === 0);
              setExpanded(expanded === item.id ? null : item.id);
            } else {
              close();
              item.run?.();
            }
          }}
        >
          {item.icon}
          <span>{item.label}</span>
          {item.checked && <Check size={16} />}
          {item.children && <ChevronRight size={14} />}
        </button>
      );
      return item.children ? (
        <div
          className="project-section-trigger"
          key={item.id}
          onPointerEnter={() => {
            retainSubmenu();
            setKeyboardSubmenu(false);
            if (!item.disabled) setExpanded(item.id);
          }}
          onPointerLeave={dismissSubmenu}
        >
          {button}
          {expanded === item.id && (
            <Submenu
              label={item.label}
              left={position.x}
              top={position.y}
              scrollRevision={scrollRevision}
              focusOnOpen={keyboardSubmenu}
            >
              {render(item.children, true)}
            </Submenu>
          )}
        </div>
      ) : (
        <div
          className={nested ? 'submenu-item' : 'context-menu-item'}
          key={item.id}
          onPointerEnter={() => {
            if (nested) retainSubmenu();
            else dismissSubmenu();
          }}
        >
          {button}
        </div>
      );
    });
  return createPortal(
    <div
      ref={root}
      className={`project-context-menu ${className}`}
      role="menu"
      aria-label={label}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (event.key === 'Tab') {
          close();
          return;
        }
        const element = event.target as HTMLElement;
        if (event.key === 'ArrowRight' && element.getAttribute('aria-haspopup') === 'menu') {
          event.preventDefault();
          retainSubmenu();
          setKeyboardSubmenu(true);
          setExpanded(element.dataset.menuId ?? null);
          return;
        }
        if (event.key === 'ArrowLeft' && element.closest('.project-section-menu')) {
          event.preventDefault();
          const trigger = element
            .closest('.project-section-trigger')
            ?.querySelector<HTMLButtonElement>(':scope > button');
          setExpanded(null);
          trigger?.focus();
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const menu = element.closest('[role="menu"]')!;
        const buttons = [
          ...menu.querySelectorAll<HTMLButtonElement>(
            ':scope > .context-menu-items > div > button:not(:disabled), :scope > div > button:not(:disabled)',
          ),
        ];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        if (menu === root.current) setExpanded(null);
        buttons[next]?.focus();
      }}
    >
      <div
        className="context-menu-items"
        onScroll={(event) => {
          if (event.target === event.currentTarget) setScrollRevision((value) => value + 1);
        }}
      >
        {render(items)}
      </div>
    </div>,
    document.body,
  );
}

function Submenu({
  label,
  left,
  top,
  scrollRevision,
  focusOnOpen,
  children,
}: {
  label: string;
  left: number;
  top: number;
  scrollRevision: number;
  focusOnOpen: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Focus after React has committed the submenu, including concurrent renders.
    if (focusOnOpen)
      ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [focusOnOpen]);
  useLayoutEffect(() => {
    const menu = ref.current!;
    const trigger = menu.parentElement!.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(
      8,
      Math.min(
        trigger.right + bounds.width + 12 > innerWidth
          ? trigger.left - bounds.width - 4
          : trigger.right + 4,
        innerWidth - bounds.width - 8,
      ),
    )}px`;
    menu.style.top = `${Math.max(8, Math.min(trigger.top, innerHeight - bounds.height - 8))}px`;
  }, [left, top, scrollRevision]);
  return (
    <div
      ref={ref}
      className="project-section-menu"
      role="menu"
      aria-label={label}
      style={{ position: 'fixed', maxHeight: innerHeight - 16 }}
    >
      {children}
    </div>
  );
}
