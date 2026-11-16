import type { AgentEvent, RunSummary } from '@hikari/agent-core';

export interface MetricsState {
  questions: string[];
  approvals: string[];
}
type Wait = 'input' | 'permission' | 'paused';

/** Aggregate before events rotate; restart downtime is excluded from active/wait timing. */
export class RunMetrics {
  readonly seen: MetricsState;
  private waits = new Set<Wait>();
  private last: number;
  constructor(
    private summary: RunSummary,
    saved?: MetricsState,
    private now = Date.now,
  ) {
    this.seen = structuredClone(saved ?? { questions: [], approvals: [] });
    this.last = now();
    summary.attention ??= {
      questions: 0,
      approvals: 0,
      denials: 0,
      interventions: 0,
      waitingMs: 0,
      inputWaitMs: 0,
      permissionWaitMs: 0,
      pausedMs: 0,
    };
  }
  tick() {
    const now = this.now(),
      elapsed = Math.max(0, now - this.last),
      metrics = this.summary.attention!;
    this.last = now;
    if (this.waits.size) metrics.waitingMs += elapsed;
    if (this.waits.has('input')) metrics.inputWaitMs += elapsed;
    if (this.waits.has('permission')) metrics.permissionWaitMs += elapsed;
    if (this.waits.has('paused')) metrics.pausedMs += elapsed;
  }
  observe(event: AgentEvent) {
    this.tick();
    const metrics = this.summary.attention!;
    if (event.type === 'agent.question') {
      const id = String((event.data.question as { id?: string })?.id ?? event.id);
      if (!this.seen.questions.includes(id)) {
        this.seen.questions.push(id);
        metrics.questions++;
      }
      this.waits.add('input');
    }
    if (event.type === 'agent.answer') this.waits.delete('input');
    if (event.type === 'permission.requested') {
      const id = String((event.data.request as { id?: string })?.id ?? event.id);
      if (!this.seen.approvals.includes(id)) {
        this.seen.approvals.push(id);
        metrics.approvals++;
      }
      this.waits.add('permission');
    }
    if (['permission.denied', 'permission.approved'].includes(event.type)) {
      if (event.type === 'permission.denied') metrics.denials++;
      this.waits.delete('permission');
    }
    if (event.type === 'agent.state' && event.data.state === 'paused') this.waits.add('paused');
    if (
      event.type === 'agent.resume_requested' ||
      (event.type === 'agent.state' && event.data.state !== 'paused')
    )
      this.waits.delete('paused');
    if (
      event.type === 'agent.state' &&
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(event.data.state))
    )
      this.waits.clear();
    metrics.interventions = metrics.questions + metrics.approvals;
  }
}
