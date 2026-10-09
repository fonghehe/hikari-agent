import { create } from 'zustand';
import type { AppPreferences } from '@hikari/shared';
import { api } from './store';

export function resolveTheme(
  theme: AppPreferences['theme'],
  systemDark: boolean,
): 'dark' | 'light' {
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
}
function apply(preferences: AppPreferences) {
  const resolvedTheme = resolveTheme(
    preferences.theme,
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.lang = preferences.language;
  document.documentElement.style.colorScheme = resolvedTheme;
  return resolvedTheme;
}
export const usePreferences = create<
  AppPreferences & {
    resolvedTheme: 'dark' | 'light';
    saving: boolean;
    save(value: AppPreferences): Promise<void>;
  }
>((set) => ({
  theme: 'dark',
  language: 'en',
  resolvedTheme: 'dark',
  saving: false,
  async save(value) {
    set({ saving: true });
    try {
      const preferences = await api().preferences.set(value);
      set({ ...preferences, resolvedTheme: apply(preferences) });
    } finally {
      set({ saving: false });
    }
  },
}));
let initialization: Promise<void> | undefined;
export function initializePreferences() {
  return (initialization ??= api()
    .preferences.get()
    .then((preferences) => {
      usePreferences.setState({ ...preferences, resolvedTheme: apply(preferences) });
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        const preferences = usePreferences.getState();
        usePreferences.setState({ resolvedTheme: apply(preferences) });
      });
    }));
}
