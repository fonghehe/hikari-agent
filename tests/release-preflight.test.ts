import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

it('validates release prerequisites without building, changing manifests or publishing', () => {
  const env = {
    PATH: process.env.PATH,
    GITHUB_REPOSITORY: 'example/fixture',
    GITHUB_REF_NAME: 'v0.1.0',
    GH_TOKEN: 'synthetic-only',
    CSC_LINK: 'synthetic-only',
    CSC_KEY_PASSWORD: 'synthetic-only',
    CSC_NAME: 'Developer ID Application: Fixture',
    APPLE_ID: 'fixture@example.invalid',
    APPLE_APP_SPECIFIC_PASSWORD: 'synthetic-only',
    APPLE_TEAM_ID: 'synthetic-only',
  };
  const success = spawnSync(process.execPath, ['scripts/release-desktop.mjs', '--check'], {
    env,
    encoding: 'utf8',
  });
  expect(success.status, success.stderr).toBe(0);
  expect(success.stdout).toContain('No build or upload');
  const missing = spawnSync(process.execPath, ['scripts/release-desktop.mjs', '--check'], {
    env: { ...env, GH_TOKEN: '' },
    encoding: 'utf8',
  });
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain('publication token');
});
