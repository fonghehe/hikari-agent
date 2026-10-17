import { Pin, Settings, List, Archive, X, Plus, Check } from 'lucide-react';
import type { WorkspaceProject } from '@hikari/shared';
import { useI18n } from './i18n';
import { ContextMenu } from './context-menu';

export type ProjectMenuAction =
  | { type: 'pin' | 'edit' | 'archive' | 'remove' | 'newSection' }
  | { type: 'section'; section: string | null };

export function ProjectMenu({
  project,
  sections,
  x,
  y,
  close,
  action,
}: {
  project: WorkspaceProject;
  sections: string[];
  x: number;
  y: number;
  close(): void;
  action(value: ProjectMenuAction): void;
}) {
  const { t } = useI18n();
  return (
    <ContextMenu
      label={t('Project actions')}
      x={x}
      y={y}
      close={close}
      items={[
        {
          id: 'pin',
          label: t(project.pinned ? 'Unpin project' : 'Pin project'),
          icon: <Pin />,
          run: () => action({ type: 'pin' }),
        },
        { id: 'edit', label: t('Edit'), icon: <Settings />, run: () => action({ type: 'edit' }) },
        null,
        {
          id: 'section',
          label: t('Section'),
          icon: <List />,
          children: [
            {
              id: 'default',
              label: t('Projects'),
              icon: !project.section ? <Check /> : undefined,
              run: () => action({ type: 'section', section: null }),
            },
            ...sections.map((section) => ({
              id: `section-${section}`,
              label: section,
              icon: project.section === section ? <Check /> : undefined,
              run: () => action({ type: 'section', section }),
            })),
            null,
            {
              id: 'new',
              label: t('New section…'),
              icon: <Plus />,
              run: () => action({ type: 'newSection' }),
            },
          ],
        },
        null,
        {
          id: 'archive',
          label: t('Archive chats'),
          icon: <Archive />,
          run: () => action({ type: 'archive' }),
        },
        null,
        {
          id: 'remove',
          label: t('Remove project'),
          icon: <X />,
          run: () => action({ type: 'remove' }),
        },
      ]}
    />
  );
}
