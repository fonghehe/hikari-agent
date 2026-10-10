import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  // Windows runners need more time for native Electron startup and screenshots.
  timeout: process.platform === 'win32' ? 60000 : 30000,
  expect: { timeout: process.platform === 'win32' ? 15000 : 5000 },
  use: { trace: 'retain-on-failure' },
  workers: 1,
});
