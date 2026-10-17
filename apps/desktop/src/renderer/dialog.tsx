import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useI18n } from './i18n';

export function Dialog({
  title,
  close,
  className = '',
  children,
  footer,
}: {
  title: string;
  close(): void;
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const startedOutside = useRef(false);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    const menu = previous?.closest('details:not([open])');
    const returnTo = menu?.querySelector('summary') ?? previous;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      dialog.close();
      requestAnimationFrame(() => {
        if (returnTo?.isConnected && !document.querySelector('dialog[open]')) returnTo.focus();
      });
    };
  }, []);
  const outside = (event: React.MouseEvent<HTMLDialogElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return (
      event.target === event.currentTarget &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    );
  };
  return (
    <dialog
      ref={ref}
      className={`modal app-dialog ${className}`}
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
      onMouseDown={(event) => {
        startedOutside.current = outside(event);
      }}
      onClick={(event) => {
        if (startedOutside.current && outside(event)) close();
      }}
    >
      <div className="dialog-header">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="dialog-close"
          aria-label={t('Close')}
          title={t('Close')}
          onClick={close}
        >
          <X size={18} />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      {footer && <div className="dialog-footer">{footer}</div>}
    </dialog>
  );
}
