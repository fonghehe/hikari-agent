import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runOptionsSchema } from '@hikari/agent-core';
import { StateStore } from './state-store';

export const automationInput = z.object({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(24000),
  cadence: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('once'), at: z.string().datetime() }),
    z.object({ kind: z.literal('interval'), minutes: z.number().int().min(1).max(525600) }),
    z.object({
      kind: z.literal('cron'),
      expression: z.string().max(120),
      timezone: z.string().default('UTC'),
    }),
  ]),
  options: runOptionsSchema.default({}),
  isolated: z.boolean().default(true),
  notify: z.enum(['changes', 'always', 'failures']).default('changes'),
  modelProfileId: z.string().max(80).optional(),
});
export type AutomationInput = z.input<typeof automationInput>;
export interface Automation extends z.output<typeof automationInput> {
  id: string;
  enabled: boolean;
  nextAt: string;
  activeTaskId?: string;
  running?: boolean;
  last?: { at: string; status: string; taskId?: string; result: string };
}

function cronField(value: number, field: string, min: number, max: number) {
  return field.split(',').some((part) => {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`Invalid cron field: ${field}`);
    const step = Number(match[2] ?? 1);
    const [start, end] = match[1] === '*' ? [min, max] : match[1]!.split('-').map(Number);
    const upper = end ?? start!;
    if (step < 1 || start! < min || upper > max || start! > upper)
      throw new Error(`Invalid cron range: ${field}`);
    return value >= start! && value <= upper && (value - start!) % step === 0;
  });
}
export function nextAutomation(cadence: Automation['cadence'], after: number): string {
  if (cadence.kind === 'once') return cadence.at;
  if (cadence.kind === 'interval') return new Date(after + cadence.minutes * 60000).toISOString();
  const fields = cadence.expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron requires five fields');
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: cadence.timezone,
    minute: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
  });
  const bounds = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  // Validate every alternative, even if an earlier alternative matches.
  fields.forEach((field, i) =>
    field
      .split(',')
      .forEach((part) => cronField(bounds[i]![0]!, part, bounds[i]![0]!, bounds[i]![1]!)),
  );
  for (
    let time = Math.floor(after / 60000) * 60000 + 60000, end = time + 366 * 86400000;
    time < end;
    time += 60000
  ) {
    const parts = Object.fromEntries(
      format.formatToParts(time).map(({ type, value }) => [type, value]),
    );
    const values = [
      Number(parts.minute),
      Number(parts.hour),
      Number(parts.day),
      Number(parts.month),
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!),
    ];
    const matches = fields.map((field, i) =>
      cronField(values[i]!, field, bounds[i]![0]!, bounds[i]![1]!),
    );
    const day =
      fields[2] === '*' || fields[4] === '*' ? matches[2] && matches[4] : matches[2] || matches[4];
    if (matches[0] && matches[1] && matches[3] && day) return new Date(time).toISOString();
  }
  throw new Error('Cron has no occurrence in the next year');
}
export class AutomationService {
  private ticking = false;
  private release?: () => void;
  constructor(private store: StateStore) {}
  list() {
    return this.store.get<Automation[]>('automations') ?? [];
  }
  create(input: AutomationInput, now = Date.now()) {
    const value = automationInput.parse(input);
    const nextAt = nextAutomation(value.cadence, now);
    if (Date.parse(nextAt) <= now) throw new Error('Choose a future execution time');
    return this.store.transaction('automations', () => {
      const all = this.list();
      if (all.length >= 100) throw new Error('At most 100 scheduled tasks');
      const record: Automation = { ...value, id: randomUUID(), enabled: true, nextAt };
      this.store.set('automations', [...all, record]);
      return record;
    });
  }
  update(id: string, enabled: boolean | null) {
    this.store.transaction('automations', () => {
      const all = this.list();
      const item = all.find((entry) => entry.id === id);
      if (!item) throw new Error('Unknown scheduled task');
      if (item.running) throw new Error('Wait for the current run before changing its schedule');
      if (enabled === null)
        this.store.set(
          'automations',
          all.filter((entry) => entry.id !== id),
        );
      else {
        item.enabled = enabled;
        if (enabled) item.nextAt = nextAutomation(item.cadence, Date.now());
        this.store.set('automations', all);
      }
    });
  }
  recover() {
    this.release ??= this.store.lease('automation-runner');
    this.store.transaction('automations', () => {
      const all = this.list();
      for (const item of all.filter((entry) => entry.running)) {
        item.running = false;
        item.enabled = false;
        item.last = {
          at: new Date().toISOString(),
          status: 'interrupted',
          taskId: item.activeTaskId,
          result:
            'Execution interrupted; inspect the saved task before re-enabling. No automatic replay.',
        };
      }
      this.store.set('automations', all);
    });
  }
  close() {
    this.release?.();
    this.release = undefined;
  }
  attach(id: string, taskId: string) {
    this.store.transaction('automations', () => {
      const all = this.list();
      const item = all.find((item) => item.id === id);
      if (!item?.running) throw new Error('Schedule is not running');
      item.activeTaskId = taskId;
      this.store.set('automations', all);
    });
  }
  async tick(
    run: (automation: Automation) => Promise<{ taskId: string; status: string; result: string }>,
    notify: (item: Automation) => void,
    now = Date.now(),
  ) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = this.store.transaction('automations', () => {
        const all = this.list();
        const due = all
          .filter((item) => item.enabled && !item.running && Date.parse(item.nextAt) <= now)
          .slice(0, 3);
        for (const item of due) {
          item.running = true;
          if (item.cadence.kind === 'once') item.enabled = false;
          else item.nextAt = nextAutomation(item.cadence, now);
        }
        this.store.set('automations', all);
        return structuredClone(due);
      });
      await Promise.all(
        due.map(async (item) => {
          let outcome;
          try {
            outcome = await run(item);
          } catch (error) {
            outcome = {
              taskId: '',
              status: 'failed',
              result: error instanceof Error ? error.message : String(error),
            };
          }
          const saved = this.store.transaction('automations', () => {
            const all = this.list();
            const current = all.find((entry) => entry.id === item.id)!;
            current.running = false;
            current.last = {
              ...outcome,
              at: new Date().toISOString(),
              result: outcome.result.slice(0, 12000),
            };
            this.store.set('automations', all);
            return current;
          });
          const failed = outcome.status !== 'completed';
          if (
            item.notify === 'always' ||
            failed ||
            (item.notify === 'changes' && item.last?.result !== saved.last?.result)
          )
            notify(saved);
        }),
      );
    } finally {
      this.ticking = false;
    }
  }
}
