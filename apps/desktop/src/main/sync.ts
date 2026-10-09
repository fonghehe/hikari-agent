import { z } from 'zod';
import { redact, type Task } from '@hikari/agent-core';
import type { LocalPersistence } from './persistence';
const records = z.array(
  z.object({
    id: z.string(),
    owner: z.string(),
    version: z.number().int(),
    data: z.unknown(),
    updatedAt: z.string(),
  }),
);
export class SyncClient {
  private base = '';
  private token = '';
  private userId = '';
  private email = '';
  constructor(private persistence: LocalPersistence) {}
  async connect(base: string, email: string, password: string, register: boolean) {
    const url = new URL(base);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new Error('Use HTTPS or a localhost server URL');
    const nextBase = base.replace(/\/$/, '');
    const auth = async (endpoint: string) => {
      const reply = await fetch(nextBase + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(15000),
      });
      if (!reply.ok) throw new Error(`Account request failed (HTTP ${reply.status})`);
      return reply.json() as Promise<unknown>;
    };
    if (register) await auth('/auth/register');
    const result = z
      .object({ token: z.string(), user: z.object({ id: z.string(), email: z.string() }) })
      .parse(await auth('/auth/login'));
    this.base = nextBase;
    this.token = result.token;
    this.userId = result.user.id;
    this.email = result.user.email;
    return result.user;
  }
  status() {
    return this.token ? { email: this.email } : null;
  }
  private async request(path: string, method = 'GET', body?: unknown) {
    if (!this.token) throw new Error('Sign in first');
    const response = await fetch(this.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 409)
      throw new Error('Sync conflict. Download the remote task snapshot before overwriting.');
    if (!response.ok) throw new Error(`Sync failed (HTTP ${response.status})`);
    return response.json() as Promise<unknown>;
  }
  async push(task: Task) {
    const key = `sync:${this.base}:${this.userId}:${task.id}`;
    const version =
      (this.persistence.get('model_configs', key)?.data as { version?: number } | undefined)
        ?.version ?? 0;
    const result = z.object({ version: z.number() }).parse(
      await this.request(`/tasks/${task.id}`, 'PUT', {
        expectedVersion: version,
        task: redact({
          ...task,
          attachments: task.attachments?.map(({ preview: _preview, ...metadata }) => metadata),
        }),
      }),
    );
    this.persistence.save('model_configs', key, { version: result.version });
    return result.version;
  }
  async pull() {
    const result: z.infer<typeof records> = [];
    for (let offset = 0; ; offset += 500) {
      const page = records.parse(await this.request(`/tasks?limit=500&offset=${offset}`));
      result.push(...page);
      if (page.length < 500) break;
      if (result.length >= 10000)
        throw new Error('Sync exceeds 10,000 snapshots; archive remote history before downloading');
    }
    for (const record of result) {
      this.persistence.save(
        'conversations',
        `remote:${this.base}:${this.userId}:${record.id}`,
        record,
      );
      this.persistence.save('model_configs', `sync:${this.base}:${this.userId}:${record.id}`, {
        version: record.version,
      });
    }
    return result;
  }
  remote(id: string) {
    if (!this.token) throw new Error('Sign in first');
    const record = this.persistence.get(
      'conversations',
      `remote:${this.base}:${this.userId}:${id}`,
    );
    if (!record) throw new Error('Download this snapshot before importing it');
    return record.data as z.infer<typeof records>[number];
  }
  async logout() {
    try {
      if (this.token) await this.request('/auth/logout', 'POST');
    } finally {
      this.token = '';
      this.email = '';
      this.userId = '';
    }
  }
}
