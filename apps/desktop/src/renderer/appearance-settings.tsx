import { Monitor, Moon, Sun, Languages, X } from 'lucide-react';
import { usePreferences } from './preferences';
import { useI18n } from './i18n';
import { perform } from './store';
export function AppearanceSettings({ close }: { close(): void }) {
  const { t } = useI18n();
  const { theme, language, saving, save } = usePreferences();
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="modal appearance-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('Appearance & language')}
      >
        <div className="progress-heading">
          <h2>{t('Appearance & language')}</h2>
          <button className="icon-button" aria-label={t('Close settings')} onClick={close}>
            <X size={18} />
          </button>
        </div>
        <p>
          {t(
            'Make this workspace feel like yours. Changes apply immediately and are saved on this device.',
          )}
        </p>
        <h3>{t('Theme')}</h3>
        <div className="theme-options" role="group" aria-label={t('Theme')}>
          {(
            [
              ['dark', Moon, 'Dark'],
              ['light', Sun, 'Light'],
              ['system', Monitor, 'System'],
            ] as const
          ).map(([value, Icon, label]) => (
            <button
              key={value}
              aria-pressed={theme === value}
              disabled={saving}
              onClick={() => void perform(() => save({ theme: value, language }))}
            >
              <span className={`theme-preview preview-${value}`}>
                <i />
                <i />
                <i />
              </span>
              <span>
                <Icon size={15} />
                {t(label)}
              </span>
            </button>
          ))}
        </div>
        <label className="language-label">
          <Languages size={16} />
          {t('Language')}
          <select
            aria-label={t('Language')}
            value={language}
            disabled={saving}
            onChange={(event) =>
              void perform(() => save({ theme, language: event.target.value as typeof language }))
            }
          >
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
            <option value="ja">日本語</option>
          </select>
        </label>
        <p className="muted">
          {t(
            'Language changes the interface. Your conversations, file names and tool output stay as written.',
          )}
        </p>
      </section>
    </div>
  );
}
