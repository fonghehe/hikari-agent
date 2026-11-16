import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { testResults } from './scripts/lib/artifacts.mjs';
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: path.join(testResults, 'runs'),
  // Windows runners need more time for native Electron startup and screenshots.
  timeout: process.platform === 'win32' ? 60000 : 30000,
  expect: { timeout: process.platform === 'win32' ? 15000 : 5000 },
  use: { trace: 'retain-on-failure', channel: process.env.HIKARI_TEST_BROWSER_CHANNEL },
  workers: 1,
});
