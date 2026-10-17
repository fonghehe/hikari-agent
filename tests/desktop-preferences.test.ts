import { describe, it, expect } from 'vitest';
import { preferencesSchema } from '../packages/shared/src';
import { buildFileTree, expandSourceLevel } from '../apps/desktop/src/renderer/file-tree';
import { translate, translations, localizedError } from '../apps/desktop/src/renderer/i18n';
import { resolveTheme } from '../apps/desktop/src/renderer/preferences';

describe('desktop preferences and explorer', () => {
  it('localizes validation messages inside Electron error wrappers', () => {
    const reason = new Error(
      "Error invoking remote method 'sections:create': Error: A section with this name already exists",
    );
    expect(localizedError(reason, 'zh-CN')).toBe('已存在同名分区');
    expect(localizedError(reason, 'ja')).toBe('同じ名前のセクションが既に存在します');
    expect(localizedError(new Error('Unexpected diagnostic'), 'zh-CN')).toBe(
      'Unexpected diagnostic',
    );
  });
  it('validates persisted settings and resolves system appearance', () => {
    expect(preferencesSchema.parse({})).toEqual({ theme: 'dark', language: 'en' });
    expect(preferencesSchema.safeParse({ theme: 'blue', language: 'fr' }).success).toBe(false);
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
  it('builds a deterministic, deduplicated directory tree with directories first', () => {
    const tree = buildFileTree([
      'README.md',
      'src/z.ts',
      'src/nested/a.ts',
      'src/a.ts',
      'src/a.ts',
      'file10.txt',
      'file2.txt',
      'assets/logo.svg',
    ]);
    expect(tree.map((entry) => entry.name)).toEqual([
      'assets',
      'src',
      'file2.txt',
      'file10.txt',
      'README.md',
    ]);
    expect(tree[1]!.children!.map((entry) => entry.path)).toEqual([
      'src/nested',
      'src/a.ts',
      'src/z.ts',
    ]);
    expect(tree[1]!.children![0]!.children).toEqual([{ name: 'a.ts', path: 'src/nested/a.ts' }]);
    expect(buildFileTree([])).toEqual([]);
    expect(buildFileTree(['src', 'src/a.ts'])[0]!.children).toHaveLength(1);
  });
  it('interpolates localized labels without translating task or tool content', () => {
    expect(translate('zh-CN', 'Appearance & language')).toBe('外观与语言');
    expect(translate('ja', 'Appearance & language')).toBe('外観と言語');
    expect(
      translate('zh-CN', '{count} tasks · Search with the sidebar field.', { count: 3 }),
    ).toContain('3');
    expect(translate('ja', 'event.agent.completed')).toBe('完了');
    expect(translate('en', 'status.not_run')).toBe('not run');
    expect(translate('ja', 'unexpected tool output')).toBe('unexpected tool output');
    for (const [key, values] of Object.entries(translations)) {
      const placeholders = (text: string) =>
        [...text.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort();
      for (const value of values) {
        expect(value.trim()).not.toBe('');
        expect(placeholders(value), key).toEqual(placeholders(key));
      }
    }
  });
  it('expands one source level while leaving dependencies and build output closed', () => {
    const tree = buildFileTree([
      'apps/web/src/main.ts',
      'apps/web/dist/app.js',
      'src/nested/file.ts',
      'node_modules/pkg/index.js',
      '.turbo/cache/entry.json',
      'dist/assets/app.js',
    ]);
    const initial = new Set<string>();
    const first = expandSourceLevel(tree, initial);
    expect([...first].sort()).toEqual(['apps', 'src']);
    expect(initial.size).toBe(0);
    const second = expandSourceLevel(tree, first);
    expect([...second].sort()).toEqual(['apps', 'apps/web', 'src', 'src/nested']);
    const third = expandSourceLevel(tree, second);
    expect(third.has('apps/web/src')).toBe(true);
    expect(third.has('apps/web/dist')).toBe(false);
    expect(third.has('node_modules')).toBe(false);
    const manuallyOpened = new Set([...third, 'node_modules']);
    expect(expandSourceLevel(tree, manuallyOpened).has('node_modules/pkg')).toBe(false);
  });
});
