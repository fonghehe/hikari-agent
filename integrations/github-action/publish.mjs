import { readFile } from 'node:fs/promises';
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('A scoped GitHub token is required for result publication');
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const report = JSON.parse(await readFile(process.env.HIKARI_CI_OUTPUT, 'utf8'));
const repository = process.env.GITHUB_REPOSITORY;
const number = event.pull_request?.number ?? event.issue?.number;
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !Number.isSafeInteger(number))
  throw new Error('Publication requires an issue or pull request event');
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
};
const base = `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository}`;
const marker = `<!-- hikari-review:${process.env.GITHUB_RUN_ID} -->`;
const previous = await fetch(`${base}/issues/${number}/comments?per_page=100`, {
  headers,
  redirect: 'error',
});
if (!previous.ok) throw new Error(`Comment lookup failed: ${previous.status}`);
const comment = (await previous.json()).find((entry) => entry.body?.includes(marker));
const response = await fetch(
  comment ? `${base}/issues/comments/${comment.id}` : `${base}/issues/${number}/comments`,
  {
    method: comment ? 'PATCH' : 'POST',
    headers,
    body: JSON.stringify({
      body: `${marker}\nHikari review · ${report.status}\n\n${String(report.answer ?? report.summary?.stopReason ?? 'No review answer').slice(0, 50000)}`,
    }),
    redirect: 'error',
  },
);
if (!response.ok) throw new Error(`Review publication failed: ${response.status}`);
