import { usePreferences } from '../../shared/preferences';
import { useEffect, useRef } from 'react';
import { useStore } from '../../app/store';

export function CodePanel({ content, original }: { content: string; original?: string }) {
  const theme = usePreferences((state) => state.resolvedTheme);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void import('./monaco')
      .then(({ mountEditor }) => {
        if (!disposed && ref.current) cleanup = mountEditor(ref.current, content, original, theme);
      })
      .catch((error) => useStore.setState({ error: String(error) }));
    return () => {
      disposed = true;
      cleanup();
    };
  }, [content, original, theme]);
  return <div className="code-panel" ref={ref} />;
}
