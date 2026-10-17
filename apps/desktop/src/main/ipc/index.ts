import { clipboard, shell, nativeTheme } from 'electron';
import { z } from 'zod';
import { preferencesSchema, type AppPreferences } from '@hikari/shared';
import type { DesktopContext, RegisterHandler } from './context';
import { registerWorkspaceHandlers } from './workspace';
import { registerModelsHandlers } from './models';
import { registerTasksHandlers } from './tasks';
import { registerServicesHandlers } from './services';
import { registerPlatformHandlers } from './platform';
import { registerMaintenanceHandlers } from './maintenance';

export function registerDesktopHandlers(
  handle: RegisterHandler,
  context: DesktopContext,
  initialPreferences: AppPreferences,
) {
  let preferences = initialPreferences;
  const { persistence } = context;
  handle('clipboard:write', (text) => clipboard.writeText(z.string().max(1000000).parse(text)));
  handle('external:open', (input) => {
    const url = new URL(z.string().url().max(4096).parse(input));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Only HTTP and HTTPS links can be opened');
    return shell.openExternal(url.toString());
  });
  handle('preferences:get', () => preferences);
  handle('preferences:set', (value) => {
    preferences = preferencesSchema.parse(value);
    persistence.save('model_configs', 'app-preferences', preferences);
    nativeTheme.themeSource = preferences.theme;
    context.window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#10131a' : '#fbfcff');
    return preferences;
  });

  registerModelsHandlers(handle, context);
  registerWorkspaceHandlers(handle, context);
  registerTasksHandlers(handle, context);
  registerServicesHandlers(handle, context);
  registerPlatformHandlers(handle, context);
  registerMaintenanceHandlers(handle, context);
}
