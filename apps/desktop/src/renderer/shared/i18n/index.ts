import type { AppPreferences } from '@hikari/shared';
import { usePreferences } from '../preferences';
import { translations } from './messages';
import { eventLabels } from './events';
export { eventLabels } from './events';
export { translations } from './messages';

export function translate(
  language: AppPreferences['language'],
  key: string,
  values: Record<string, string | number> = {},
): string {
  const normalized = key.replace(/\s+/g, ' ').trim();
  const event = eventLabels[normalized];
  const entry = translations[normalized];
  const english =
    event?.[0] ??
    (normalized.startsWith('event.')
      ? normalized.slice(6).replaceAll('.', ' / ').replaceAll('_', ' ')
      : normalized.startsWith('status.')
        ? normalized.slice(7).replaceAll('_', ' ')
        : normalized);
  const message =
    language === 'en'
      ? english
      : (event?.[language === 'zh-CN' ? 1 : 2] ?? entry?.[language === 'zh-CN' ? 0 : 1] ?? english);
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    String(values[name] ?? placeholder),
  );
}
export function useI18n() {
  const language = usePreferences((state) => state.language);
  return {
    language,
    locale: language === 'en' ? 'en-US' : language === 'ja' ? 'ja-JP' : 'zh-CN',
    t: (key: string, values?: Record<string, string | number>) => translate(language, key, values),
  };
}
export const tr = (key: string, values?: Record<string, string | number>) =>
  translate(usePreferences.getState().language, key, values);

export function localizedError(
  reason: unknown,
  language = usePreferences.getState().language,
): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  return translate(
    language,
    text.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, ''),
  );
}
