import { useI18n } from '../../shared/i18n/index';
import { usePreferences } from '../../shared/preferences';
import { useEffect, useRef, useState } from 'react';
import type { Terminal as XTerminal } from '@xterm/xterm';
import { Button } from '@hikari/ui';
import { api, perform, useStore } from '../../app/store';

export function TerminalPanel({ taskId }: { taskId?: string }) {
  const theme = usePreferences((state) => state.resolvedTheme);
  const { t } = useI18n();

  const ref = useRef<HTMLDivElement>(null);
  const live = useRef<{ id: string; terminal: XTerminal; exited: boolean } | null>(null);
  const pending = useRef(new Map<string, { data: string; exited: boolean }>());
  const [exited, setExited] = useState(false);
  const [id, setId] = useState<string>();
  const [opening, setOpening] = useState(false);
  const workspace = useStore((state) => state.workspace);
  const terminalTheme = () =>
    usePreferences.getState().resolvedTheme === 'dark'
      ? { background: '#151820', foreground: '#e8ebf4', cursor: '#8b9eff' }
      : { background: '#fbfcff', foreground: '#20283b', cursor: '#526bea' };
  useEffect(() => {
    if (live.current) live.current.terminal.options.theme = terminalTheme();
  }, [theme]);
  useEffect(
    () =>
      api().terminal.subscribe((event) => {
        if (live.current?.id === event.id) {
          live.current.terminal.write(event.data);
          if (event.exited) {
            live.current.exited = true;
            live.current.terminal.options.disableStdin = true;
            setExited(true);
          }
        } else {
          const previous = pending.current.get(event.id);
          pending.current.set(event.id, {
            data: ((previous?.data ?? '') + event.data).slice(-65536),
            exited: !!event.exited || !!previous?.exited,
          });
          if (pending.current.size > 3)
            pending.current.delete(pending.current.keys().next().value!);
        }
      }),
    [],
  );
  useEffect(() => {
    if (!id || !ref.current) return;
    let disposed = false;
    let cleanup = () => {};
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      .then(async ([{ Terminal }, { FitAddon }]) => {
        // The face only covers private-use glyphs; the default space matches none.
        await document.fonts.load('13px "Hikari Powerline Symbols"', '\uE0B0');
        if (disposed || !ref.current) return;
        const term = new Terminal({
          theme: terminalTheme(),
          fontSize: 13,
          fontFamily:
            '"Hikari Powerline Symbols", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
          lineHeight: 1.25,
          minimumContrastRatio: 4.5,
          scrollback: 2000,
          screenReaderMode: true,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        // Attach protocol replies before parsing any buffered startup queries.
        const input = term.onData((data) => {
          if (live.current?.id === id && !live.current.exited)
            void perform(() => api().terminal.write(id, data));
        });
        term.open(ref.current);
        // xterm 5's screen-reader mode ignores non-composition insertText events
        // (for example emoji keyboards). Keep accessibility enabled and route
        // those insertions through its public paste API exactly once.
        const beforeInput = (event: InputEvent) => {
          if (
            event.inputType === 'insertText' &&
            event.data &&
            Array.from(event.data).some((character) => character.charCodeAt(0) > 127) &&
            !event.isComposing &&
            event.cancelable
          ) {
            event.preventDefault();
            term.paste(event.data);
          }
        };
        term.textarea?.addEventListener('beforeinput', beforeInput);
        const buffered = pending.current.get(id);
        live.current = { id, terminal: term, exited: !!buffered?.exited };
        if (buffered) {
          term.write(buffered.data);
          pending.current.delete(id);
        }
        setExited(!!buffered?.exited);
        term.options.disableStdin = !!buffered?.exited;
        term.focus();
        fit.fit();
        const resize = () => {
          if (live.current?.exited) return;
          fit.fit();
          void perform(() => api().terminal.resize(id, term.cols, term.rows));
        };
        const observer = new ResizeObserver(resize);
        observer.observe(ref.current);
        cleanup = () => {
          observer.disconnect();
          live.current = null;
          pending.current.delete(id);
          term.textarea?.removeEventListener('beforeinput', beforeInput);
          input.dispose();
          term.dispose();
        };
        resize();
      })
      .catch((error) => useStore.setState({ error: String(error) }));
    return () => {
      disposed = true;
      cleanup();
      void api()
        .terminal.kill(id)
        .catch(() => {});
    };
  }, [id]);
  return (
    <>
      <Button
        variant="outline"
        disabled={opening || (!workspace && !taskId)}
        onClick={() => {
          if (opening) return;
          setOpening(true);
          void perform(async () => {
            setId(await api().terminal.create(taskId));
          }).finally(() => setOpening(false));
        }}
      >
        {opening ? t('Opening…') : id ? t('Restart terminal') : t('Open terminal')}
      </Button>
      {!workspace && !taskId && (
        <p className="muted">{t('Open a workspace to start an interactive terminal.')}</p>
      )}
      {exited && (
        <p role="status" className="muted">
          {t('Terminal exited. Restart to open a new session.')}
        </p>
      )}
      <div ref={ref} className="terminal-panel" />
    </>
  );
}
