import { test, expect } from '@playwright/test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RemoteControlServer, SuperagentSession } from '../../packages/agent-host/src/index';
import type { ModelProvider, ModelResponse } from '../../packages/agent-core/src/index';

test('supervises a structured question, follow-up, review and silent observe decision in the real page', async ({
  page,
}) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-superagent-page-')));
  let step = 0;
  const provider: ModelProvider = {
    countTokens: () => 1,
    async chat(): Promise<ModelResponse> {
      const current = step++;
      if (current === 0)
        return {
          text: '',
          toolCalls: [
            {
              id: 'blocked',
              name: 'report_work',
              input: {
                status: 'blocked',
                text: 'A target decision is required.',
                humanAction: { question: 'Which target should I inspect?' },
              },
            },
          ],
        };
      if (current === 1)
        return {
          text: '',
          toolCalls: [
            {
              id: 'ready',
              name: 'report_work',
              input: {
                status: 'ready',
                text: 'Fixture ready for review.',
                reviewRequired: true,
              },
            },
          ],
        };
      return { text: 'Completed the inspection with fixture evidence.', toolCalls: [] };
    },
    async *stream(request) {
      yield await this.chat(request);
    },
  };
  const session = new SuperagentSession({
    root,
    provider,
    assess: async (_trigger, policy) => ({
      policyVersion: policy.version,
      scope: 'Inspect failed CI',
      rules: [{ id: 'ci', matches: true, reason: 'CI failure fixture' }],
    }),
  });
  const server = new RemoteControlServer(session, 'fixture-token-'.repeat(5));
  const info = await server.listen(0);
  const timer = setInterval(() => {
    void session.tick();
  }, 50);
  try {
    await page.goto(`http://127.0.0.1:${info.port}`);
    await page.getByLabel('Access token').fill(info.token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('#project')).toHaveText(root);
    await page.locator('#prompt').fill('Inspect the selected target');
    await page.getByLabel('Mode', { exact: true }).selectOption('plan');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.locator('#attention')).toContainText('Awaiting answer');
    await expect(page.locator('#approval')).toContainText('Which target should I inspect?');
    expect(session.host.runners.size).toBe(0);
    await page.locator('#message').fill('Inspect staging.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#attention')).toContainText('Awaiting review');
    expect(session.superagent.snapshot().tickets[0]?.assignments).toHaveLength(2);
    await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
    await expect(page.locator('#attention-section')).toBeHidden();
    const policy = session.superagent.snapshot().policy;
    const headers = { Authorization: `Bearer ${info.token}` };
    const saved = await page.request.post(`http://127.0.0.1:${info.port}/api/superagent/policy`, {
      headers,
      data: {
        baseVersion: policy.version,
        policy: {
          ...policy,
          sources: [
            ...policy.sources,
            { id: 'github', threads: ['*'], bots: ['ci'], receiveAll: true },
          ],
          rules: [{ id: 'ci', instruction: 'Inspect failing CI in this repository.' }],
        },
      },
    });
    expect(saved.ok()).toBe(true);
    const event = await page.request.post(`http://127.0.0.1:${info.port}/api/superagent/triggers`, {
      headers,
      data: {
        id: 'ci-1',
        source: 'github',
        thread: 'pr:42',
        actor: 'ci',
        actorKind: 'bot',
        addressed: false,
        text: 'CI failed',
      },
    });
    expect(event.status()).toBe(202);
    await page.getByText('Intake history', { exact: true }).click();
    await expect(page.locator('#history')).toContainText('would accept');
    expect(session.superagent.snapshot().tickets).toHaveLength(1);
    expect(session.superagent.snapshot().notices.map((notice) => notice.kind)).toEqual([
      'acknowledgement',
      'attention',
      'result',
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath('superagent-mobile.png'),
      fullPage: true,
    });
    await expect(page.locator('#error')).toBeEmpty();
  } finally {
    clearInterval(timer);
    await server.close();
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
