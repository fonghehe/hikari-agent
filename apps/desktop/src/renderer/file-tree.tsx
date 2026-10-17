import { useMemo, useState, type KeyboardEvent } from 'react';
import {
  ChevronRight,
  ChevronsDownUp,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
} from 'lucide-react';
import { useI18n } from './i18n';

export interface FileNode {
  name: string;
  path: string;
  children?: FileNode[];
}
export function buildFileTree(paths: string[]): FileNode[] {
  const root: FileNode[] = [];
  const entries = new Map<string, FileNode>();
  for (const path of new Set(paths)) {
    const parts = path.split('/').filter(Boolean);
    let nodes = root;
    let key = '';
    parts.forEach((name, index) => {
      key = key ? `${key}/${name}` : name;
      let node = entries.get(key);
      if (!node) {
        node = { name, path: key };
        entries.set(key, node);
        nodes.push(node);
      }
      if (index < parts.length - 1) {
        node.children ??= [];
        nodes = node.children;
      }
    });
  }
  const sort = (nodes: FileNode[]) => {
    nodes.sort(
      (a, b) =>
        Number(!!b.children) - Number(!!a.children) ||
        a.name.localeCompare(b.name, 'en', { numeric: true }),
    );
    for (const node of nodes) if (node.children) sort(node.children);
  };
  sort(root);
  return root;
}
const generatedFolders = new Set([
  'node_modules',
  '.pnpm-store',
  '.pnpm',
  '.turbo',
  '.git',
  '.cache',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.nitro',
]);
export function expandSourceLevel(nodes: FileNode[], expanded: Set<string>): Set<string> {
  const next = new Set(expanded);
  const visit = (items: FileNode[]) => {
    for (const node of items) {
      if (!node.children || generatedFolders.has(node.name)) continue;
      if (expanded.has(node.path)) visit(node.children);
      else next.add(node.path);
    }
  };
  visit(nodes);
  return next;
}
export function FileTree({ files, onOpen }: { files: string[]; onOpen(path: string): void }) {
  const { t } = useI18n();
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [expandedPaths, setExpanded] = useState(new Set<string>());
  const toggle = (path: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const keydown = (event: KeyboardEvent<HTMLButtonElement>, node: FileNode) => {
    const buttons = [
      ...event.currentTarget
        .closest('[role="tree"]')!
        .querySelectorAll<HTMLButtonElement>('button[role="treeitem"]'),
    ];
    const index = buttons.indexOf(event.currentTarget);
    if (event.key === 'ArrowDown') buttons[index + 1]?.focus();
    else if (event.key === 'ArrowUp') buttons[index - 1]?.focus();
    else if (event.key === 'Home') buttons[0]?.focus();
    else if (event.key === 'End') buttons.at(-1)?.focus();
    else if (node.children && event.key === 'ArrowLeft' && expandedPaths.has(node.path))
      toggle(node.path);
    else if (event.key === 'ArrowLeft') {
      const parent = node.path.slice(0, node.path.lastIndexOf('/'));
      buttons.find((button) => button.getAttribute('aria-label') === parent)?.focus();
    } else if (node.children && event.key === 'ArrowRight') {
      if (!expandedPaths.has(node.path)) toggle(node.path);
      else buttons[index + 1]?.focus();
    } else return;
    event.preventDefault();
  };
  const render = (nodes: FileNode[], depth: number) =>
    nodes.map((node) => {
      const expanded = expandedPaths.has(node.path);
      const Icon = node.children
        ? expanded
          ? FolderOpen
          : Folder
        : /\.json$/.test(node.name)
          ? FileJson
          : /\.(md|txt)$/.test(node.name)
            ? FileText
            : FileCode2;
      return (
        <li key={node.path} role="none">
          <button
            role="treeitem"
            aria-label={node.path}
            aria-expanded={node.children ? expanded : undefined}
            aria-level={depth + 1}
            className={`tree-row ${node.children ? 'tree-folder' : ''}`}
            style={{ paddingLeft: 8 + depth * 16 }}
            title={node.path}
            onKeyDown={(event) => keydown(event, node)}
            onClick={() => (node.children ? toggle(node.path) : onOpen(node.path))}
          >
            {node.children ? (
              <ChevronRight
                className={expanded ? 'tree-chevron expanded' : 'tree-chevron'}
                size={12}
              />
            ) : (
              <span className="tree-indent" />
            )}
            <Icon size={15} />
            <span>{node.name}</span>
            {node.children && <small>{node.children.length}</small>}
          </button>
          {node.children && expanded && <ul role="group">{render(node.children, depth + 1)}</ul>}
        </li>
      );
    });
  return (
    <div className="file-tree">
      <div className="tree-tools">
        <span>{t('Explorer')}</span>
        <button
          title={t('Expand source folders one level')}
          aria-label={t('Expand one level')}
          onClick={() => setExpanded((previous) => expandSourceLevel(tree, previous))}
        >
          {t('Expand one level')}
        </button>
        <button
          title={t('Collapse all')}
          aria-label={t('Collapse all')}
          onClick={() => setExpanded(new Set())}
        >
          <ChevronsDownUp size={14} />
        </button>
      </div>
      <ul role="tree" aria-label={t('File tree')}>
        {render(tree, 0)}
      </ul>
      {files.length === 0 && <p className="muted">{t('No files in this workspace.')}</p>}
    </div>
  );
}
