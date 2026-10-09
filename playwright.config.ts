import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30000,
  use: { trace: 'retain-on-failure' },
  workers: 1,
});
