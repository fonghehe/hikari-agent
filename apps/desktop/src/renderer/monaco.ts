import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.editor.defineTheme('hikari-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#151820',
    'editor.foreground': '#e8ebf4',
    'editor.lineHighlightBackground': '#202941',
    'scrollbarSlider.background': '#454e6366',
    'scrollbarSlider.hoverBackground': '#737f9999',
    'scrollbarSlider.activeBackground': '#737f99cc',
  },
});
monaco.editor.defineTheme('hikari-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#fbfcff',
    'editor.foreground': '#20283b',
    'editor.lineHighlightBackground': '#edf0ff',
    'scrollbarSlider.background': '#bbc4d677',
    'scrollbarSlider.hoverBackground': '#8b98b199',
    'scrollbarSlider.activeBackground': '#8b98b1cc',
  },
});
export function mountEditor(
  element: HTMLElement,
  content: string,
  original?: string,
  theme: 'dark' | 'light' = 'dark',
) {
  const common = {
    theme: `hikari-${theme}`,
    readOnly: true,
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 12,
    scrollBeyondLastLine: false,
    scrollbar: { verticalScrollbarSize: 7, horizontalScrollbarSize: 7, useShadows: false },
  };
  if (original !== undefined) {
    const editor = monaco.editor.createDiffEditor(element, {
      ...common,
      renderSideBySide: false,
    });
    const before = monaco.editor.createModel(original, 'plaintext');
    const after = monaco.editor.createModel(content, 'plaintext');
    editor.setModel({ original: before, modified: after });
    return () => {
      editor.dispose();
      before.dispose();
      after.dispose();
    };
  }
  const model = monaco.editor.createModel(content, 'plaintext');
  const editor = monaco.editor.create(element, { ...common, model });
  return () => {
    editor.dispose();
    model.dispose();
  };
}
