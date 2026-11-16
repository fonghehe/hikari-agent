import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    // Native file operations (SQLite, Git and document extraction) are slower on
    // hosted Windows. Bound CI concurrency so these integrations do not compete
    // for the same disk, and retain a finite platform-specific deadline.
    maxWorkers: process.env.CI ? 2 : undefined,
    testTimeout: process.platform === 'win32' ? 30000 : 10000,
    reporters: ['default', 'junit'],
    outputFile: { junit: '.artifacts/test-results/unit.xml' },
  },
});
