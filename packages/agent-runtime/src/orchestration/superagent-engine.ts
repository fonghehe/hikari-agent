import { randomUUID } from 'node:crypto';
import {
  assessmentSchema,
  runOptionsSchema,
  superagentPolicySchema,
  triggerSchema,
  workReportSchema,
  ticketStage,
  type Assessment,
  type IntakeDecision,
  type SuperagentPolicy,
  type Ticket,
  type Trigger,
  type WorkReport,
  type RunOptions,
  type Task,
  type ModelUsage,
} from '@hikari/agent-core';
import { StateStore } from '../persistence/state-store';

export interface SuperagentJob {
  id: string;
  ticketId: string;
  assignmentId: string;
  kind: 'launch' | 'input' | 'stop';
  inputId?: string;
  inputIds?: string[];
  state: 'pending' | 'running' | 'failed';
  attempts: number;
  nextAt: number;
  error?: string;
}
export interface SuperagentNotice {
  id: string;
  ticketId: string;
  source: string;
  thread: string;
  kind: 'acknowledgement' | 'result' | 'attention';
  text: string;
}
interface State {
  version: 1;
  policy: SuperagentPolicy;
  policies: SuperagentPolicy[];
  triggers: { trigger: Trigger; pending: boolean }[];
  decisions: IntakeDecision[];
  tickets: Ticket[];
  jobs: SuperagentJob[];
  notices: SuperagentNotice[];
  assessments?: {
    id: string;
    source: string;
    triggerId: string;
    state: 'pending' | 'reported' | 'unknown';
    startedAt: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    estimated?: boolean;
  }[];
  accounting?: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    unpricedCalls: number;
    unknownCalls: number;
  };
}

/** Single writer. Domain changes and external-work intents commit in the same atomic file. */
export class SuperagentEngine {
  constructor(
    private store: Pick<StateStore, 'get' | 'set' | 'transaction'>,
    private now = Date.now,
  ) {}
  private read(): State {
    return (
      this.store.get<State>('superagent') ?? {
        version: 1,
        policy: { ...superagentPolicySchema.parse({ sources: [] }), version: randomUUID() },
        policies: [],
        triggers: [],
        decisions: [],
        tickets: [],
        jobs: [],
        notices: [],
      }
    );
  }
  private write<T>(change: (state: State) => T): T {
    return this.store.transaction('superagent', () => {
      const state = this.read();
      const result = change(state);
      this.store.set('superagent', state);
      return structuredClone(result);
    });
  }
  snapshot() {
    return this.read();
  }
  beginAssessment(trigger: Trigger, reservedCostUsd?: number) {
    return this.write((state) => {
      const accounting = (state.accounting ??= {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        unpricedCalls: 0,
        unknownCalls: 0,
      });
      const budget = state.policy.assessmentBudget;
      if (
        budget?.maxCostUsd !== undefined &&
        (reservedCostUsd === undefined ||
          !Number.isFinite(reservedCostUsd) ||
          reservedCostUsd < 0 ||
          accounting.unpricedCalls > 0 ||
          accounting.costUsd + reservedCostUsd > budget.maxCostUsd)
      )
        throw new Error(
          'Assessment cost budget cannot cover the request or has unknown billing; inspect accounting and pricing.',
        );
      if (
        accounting.calls >= (budget?.maxCalls ?? 1000) ||
        (budget?.maxCostUsd !== undefined && accounting.costUsd >= budget.maxCostUsd)
      )
        throw new Error(
          'Proactive assessment budget exhausted; inspect accounting and update the explicit policy budget.',
        );
      const record = {
        id: randomUUID(),
        source: trigger.source,
        triggerId: trigger.id,
        state: 'pending' as const,
        startedAt: new Date(this.now()).toISOString(),
      };
      accounting.calls++;
      state.assessments = [
        ...(state.assessments ?? [])
          .filter(
            (entry) =>
              entry.state === 'pending' ||
              entry.startedAt >= new Date(this.now() - 7 * 86400000).toISOString(),
          )
          .slice(-499),
        record,
      ];
      return record.id;
    });
  }
  finishAssessment(id: string, usage?: ModelUsage, costUsd?: number) {
    this.write((state) => {
      const record = state.assessments?.find((entry) => entry.id === id);
      if (!record || record.state !== 'pending') return;
      record.state = usage ? 'reported' : 'unknown';
      record.inputTokens = usage?.inputTokens;
      record.outputTokens = usage?.outputTokens;
      record.costUsd = costUsd;
      record.estimated = usage?.estimated;
      const accounting = state.accounting!;
      accounting.inputTokens += usage?.inputTokens ?? 0;
      accounting.outputTokens += usage?.outputTokens ?? 0;
      accounting.costUsd += costUsd ?? 0;
      if (costUsd === undefined) accounting.unpricedCalls++;
      if (!usage) accounting.unknownCalls++;
    });
  }
  /** All first-party interactive entry points adopt explicit user work into the same domain. */
  adoptExecution(task: Task) {
    return this.write((state) => {
      let ticket = task.workItem
        ? this.ticket(state, task.workItem.ticketId)
        : state.tickets.find((ticket) =>
            ticket.assignments.some((assignment) => assignment.taskId === task.id),
          );
      if (!ticket) {
        const trigger: Trigger = {
          id: task.id,
          source: 'local',
          thread: task.parentTaskId ?? task.id,
          actor: 'operator',
          actorKind: 'human',
          addressed: true,
          text: task.prompt.slice(0, 12000),
        };
        state.triggers.push({ trigger, pending: true });
        const decision = this.decide(state, trigger, undefined, {
          options: task.runOptions,
          isolated: !!task.worktree,
        });
        if (decision.outcome !== 'accept')
          throw new Error('The current policy does not authorize this request');
        ticket = this.ticket(state, decision.ticketId!);
        ticket.assignments[0]!.taskId = task.id;
        state.jobs = state.jobs.filter((job) => job.ticketId !== ticket!.id);
      } else if (ticket.outcome === 'stopped' || ticket.outcome === 'revoked') {
        throw new Error('The work mandate was withdrawn; start a new request');
      } else if (!this.validMandate(state, ticket)) {
        throw new Error('The work mandate no longer holds under the current policy');
      }
      ticket.state = 'open';
      ticket.outcome = undefined;
      ticket.report = undefined;
      const assignment = ticket.assignments.at(-1)!;
      assignment.state = 'running';
      for (const input of ticket.inputs) {
        input.delivered = true;
        input.read = true;
      }
      task.mandate = structuredClone(ticket.mandate);
      task.workItem = { ticketId: ticket.id, assignmentId: assignment.id, stage: 'working' };
      return task.workItem;
    });
  }
  private ticket(state: State, id: string) {
    const ticket = state.tickets.find((ticket) => ticket.id === id);
    if (!ticket) throw new Error('Unknown ticket');
    return ticket;
  }
  private listens(state: State, trigger: Pick<Trigger, 'source' | 'thread'>) {
    return state.policy.sources.find(
      (source) =>
        source.id === trigger.source &&
        source.enabled &&
        source.threads.some((thread) => thread === '*' || thread === trigger.thread),
    );
  }
  private gate(state: State, trigger: Trigger) {
    const source = this.listens(state, trigger);
    if (!source) return;
    if (
      trigger.actorKind === 'human' &&
      source.allowedActors.includes(trigger.actor) &&
      trigger.addressed
    )
      return 'explicit';
    if (state.policy.mode === 'off') return;
    if (trigger.actorKind === 'bot')
      return source.bots.includes(trigger.actor) && (trigger.addressed || source.receiveAll)
        ? 'inferred'
        : undefined;
    if (
      source.receiveAll &&
      (trigger.actorKind === 'system' || source.allowedActors.includes(trigger.actor))
    )
      return 'inferred';
  }
  private validMandate(state: State, ticket: Ticket) {
    const mandate = ticket.mandate;
    const source = this.listens(state, mandate);
    if (!source) return false;
    if (mandate.strength === 'explicit') return source.allowedActors.includes(mandate.actor);
    return (
      state.policy.mode === 'auto' &&
      (mandate.actorKind === 'human'
        ? source.allowedActors.includes(mandate.actor)
        : mandate.actorKind === 'bot'
          ? source.bots.includes(mandate.actor)
          : source.receiveAll) &&
      mandate.rules.length > 0 &&
      mandate.rules.every((rule) =>
        state.policy.rules.some(
          (current) =>
            current.enabled && current.id === rule.id && current.instruction === rule.instruction,
        ),
      )
    );
  }
  private job(state: State, ticket: Ticket, kind: SuperagentJob['kind'], inputId?: string) {
    const assignment = ticket.assignments.at(-1)!;
    if (
      state.jobs.some(
        (job) =>
          job.ticketId === ticket.id &&
          job.assignmentId === assignment.id &&
          job.kind === kind &&
          job.inputId === inputId,
      )
    )
      return;
    state.jobs.push({
      id: randomUUID(),
      ticketId: ticket.id,
      assignmentId: assignment.id,
      kind,
      inputId,
      state: 'pending',
      attempts: 0,
      nextAt: this.now(),
    });
  }
  private notice(state: State, ticket: Ticket, kind: SuperagentNotice['kind'], text: string) {
    // Local Channel: persisted notices are exposed to the originating source/thread by the host.
    state.notices.push({
      id: randomUUID(),
      ticketId: ticket.id,
      source: ticket.mandate.source,
      thread: ticket.mandate.thread,
      kind,
      text,
    });
  }
  private assignment(state: State, ticket: Ticket) {
    const previous = ticket.assignments.at(-1);
    ticket.assignments.push({
      id: randomUUID(),
      taskId: randomUUID(),
      state: 'pending',
      previousTaskId: previous?.taskId,
    });
    ticket.report = undefined;
    ticket.deliveryError = undefined;
    for (const input of ticket.inputs) if (!input.read) input.delivered = false;
    this.job(state, ticket, 'launch');
  }
  configure(input: unknown, baseVersion?: string) {
    const parsed = superagentPolicySchema.parse(input);
    return this.write((state) => {
      if (baseVersion && baseVersion !== state.policy.version)
        throw new Error('Policy changed; reload before saving');
      state.policy = { ...parsed, version: randomUUID() };
      state.policies.push(state.policy);
      for (const ticket of state.tickets.filter((ticket) => ticket.state === 'open')) {
        // A change is context, never an implicit cancel or a new grant.
        const trigger: Trigger = {
          id: randomUUID(),
          source: ticket.mandate.source,
          thread: ticket.mandate.thread,
          actor: 'policy',
          actorKind: 'system',
          addressed: false,
          text: `Policy changed to ${state.policy.version}. Continue only within your original mandate. Current policy: ${JSON.stringify(state.policy)}`,
        };
        ticket.inputs.push({
          id: randomUUID(),
          trigger,
          delivered: false,
          read: false,
          contextOnly: true,
        });
        if (ticket.assignments.at(-1)?.state === 'running')
          this.job(state, ticket, 'input', ticket.inputs.at(-1)!.id);
      }
      return state.policy;
    });
  }
  receive(input: unknown, options?: { options?: RunOptions; isolated?: boolean }) {
    const trigger = triggerSchema.parse(input);
    return this.write((state) => {
      const existing = state.triggers.find(
        (entry) => entry.trigger.id === trigger.id && entry.trigger.source === trigger.source,
      );
      if (existing) {
        if (JSON.stringify(existing.trigger) !== JSON.stringify(trigger))
          throw new Error('Trigger identity reused with different content');
        return {
          duplicate: true,
          decision: state.decisions
            .filter(
              (decision) =>
                decision.trigger.id === trigger.id && decision.trigger.source === trigger.source,
            )
            .at(-1),
        };
      }
      const record = { trigger, pending: false };
      state.triggers.push(record);
      if (!this.listens(state, trigger)) return { filtered: true };
      const owners: Ticket[] = [];
      for (const ticket of state.tickets) {
        const subscription = ticket.subscriptions.find(
          (entry) => entry.source === trigger.source && entry.thread === trigger.thread,
        );
        if (!subscription || ['stopped', 'revoked'].includes(ticket.outcome ?? '')) continue;
        const humanFollowup = trigger.actorKind === 'human' && !subscription.contextOnly;
        if (ticket.state === 'ended') {
          if (!humanFollowup) continue;
          if (!this.validMandate(state, ticket)) {
            ticket.outcome = 'revoked';
            continue;
          }
          ticket.state = 'open';
          ticket.outcome = undefined;
          this.assignment(state, ticket);
        }
        if (
          !ticket.paused &&
          ticket.assignments.at(-1)?.state === 'ended' &&
          ['waiting', 'ready'].includes(ticket.report?.status ?? '')
        )
          this.assignment(state, ticket);
        ticket.inputs.push({
          id: randomUUID(),
          trigger,
          delivered: false,
          read: false,
          contextOnly: !humanFollowup,
        });
        if (humanFollowup) owners.push(ticket);
        const held =
          ticket.paused ||
          ['blocked', 'failed', 'ready', 'waiting'].includes(ticket.report?.status ?? '');
        if (humanFollowup && !ticket.paused) {
          if (ticket.assignments.at(-1)?.state === 'ended') this.assignment(state, ticket);
          ticket.report = undefined;
          ticket.deliveryError = undefined;
        }
        if (
          !ticket.paused &&
          (!held || humanFollowup) &&
          ticket.assignments.at(-1)?.state === 'running'
        )
          this.job(state, ticket, 'input', ticket.inputs.at(-1)!.id);
      }
      if (owners.length) {
        const decision: IntakeDecision = {
          id: randomUUID(),
          trigger,
          policyVersion: state.policy.version,
          outcome: 'delivered',
          reason: 'Human follow-up belongs to its subscribed executor',
          ticketId: owners[0]!.id,
        };
        state.decisions.push(decision);
        return { decision };
      }
      record.pending = true;
      const strength = this.gate(state, trigger);
      if (strength === 'inferred' && state.policy.rules.some((rule) => rule.enabled))
        return { pending: true };
      if (strength === 'inferred')
        return {
          decision: this.decide(
            state,
            trigger,
            {
              policyVersion: state.policy.version,
              scope: trigger.text.slice(0, 4000),
              rules: [],
            },
            options,
          ),
        };
      return { decision: this.decide(state, trigger, undefined, options) };
    });
  }
  private decide(
    state: State,
    trigger: Trigger,
    assessment?: Assessment,
    options?: { options?: RunOptions; isolated?: boolean },
  ) {
    const strength = this.gate(state, trigger);
    const decision: IntakeDecision = {
      id: randomUUID(),
      trigger,
      policyVersion: state.policy.version,
      outcome: 'ignore',
      reason: 'Source policy does not admit this request',
    };
    const record = state.triggers.find(
      (entry) => entry.trigger.source === trigger.source && entry.trigger.id === trigger.id,
    )!;
    record.pending = false;
    let scope = trigger.text;
    let rules: SuperagentPolicy['rules'] = [];
    if (strength === 'inferred') {
      const enabled = state.policy.rules.filter((rule) => rule.enabled);
      if (!assessment || assessment.policyVersion !== state.policy.version) {
        decision.outcome = 'unavailable';
        decision.reason = 'Assessment unavailable or policy changed; evaluate again';
      } else {
        const ids = assessment.rules.map((rule) => rule.id);
        if (
          new Set(ids).size !== ids.length ||
          ids.length !== enabled.length ||
          enabled.some((rule) => !ids.includes(rule.id))
        )
          throw new Error('Assess every enabled rule exactly once');
        rules = enabled.filter((rule) =>
          assessment.rules.some((result) => result.id === rule.id && result.matches),
        );
        scope = assessment.scope;
        decision.reason = rules.length ? 'Matched written rules' : 'No written rule matched';
        decision.wouldAccept = rules.length > 0 && state.policy.mode === 'observe';
      }
    }
    const accepted =
      strength === 'explicit' ||
      (strength === 'inferred' &&
        decision.outcome !== 'unavailable' &&
        rules.length > 0 &&
        state.policy.mode === 'auto');
    if (accepted) {
      const ticket: Ticket = {
        id: randomUUID(),
        mandate: {
          triggerId: trigger.id,
          source: trigger.source,
          thread: trigger.thread,
          actor: trigger.actor,
          actorKind: trigger.actorKind,
          policyVersion: state.policy.version,
          strength: strength!,
          scope,
          rules: rules.map(({ id, instruction }) => ({ id, instruction })),
        },
        state: 'open',
        paused: false,
        options: runOptionsSchema.parse(options?.options ?? {}),
        isolated: options?.isolated ?? true,
        assignments: [],
        subscriptions: [{ source: trigger.source, thread: trigger.thread, contextOnly: false }],
        inputs: [{ id: randomUUID(), trigger, delivered: false, read: false, contextOnly: false }],
      };
      if (ticket.options.mode === 'plan') ticket.isolated = false;
      state.tickets.push(ticket);
      this.assignment(state, ticket);
      decision.outcome = 'accept';
      decision.reason =
        strength === 'explicit' ? 'Explicit request by an allowed person' : 'Matched written rules';
      decision.ticketId = ticket.id;
      this.notice(state, ticket, 'acknowledgement', `Accepted: ${scope}`);
    }
    state.decisions.push(decision);
    return decision;
  }
  assess(source: string, id: string, input?: unknown) {
    const assessment = input === undefined ? undefined : assessmentSchema.parse(input);
    return this.write((state) => {
      const record = state.triggers.find(
        (entry) => entry.trigger.source === source && entry.trigger.id === id,
      );
      if (!record?.pending) throw new Error('Trigger is not awaiting assessment');
      return this.decide(state, record.trigger, assessment);
    });
  }
  reevaluate(source: string, id: string) {
    this.write((state) => {
      const record = state.triggers.find(
        (entry) => entry.trigger.source === source && entry.trigger.id === id,
      );
      if (!record) throw new Error('Unknown trigger');
      if (
        state.decisions.some(
          (decision) =>
            decision.trigger.source === source &&
            decision.trigger.id === id &&
            ['accept', 'delivered'].includes(decision.outcome),
        )
      )
        throw new Error('Trigger already belongs to a ticket');
      record.pending = true;
    });
  }
  subscribe(id: string, source: string, thread: string) {
    this.write((state) => {
      const ticket = this.ticket(state, id);
      if (!this.listens(state, { source, thread }))
        throw new Error('Source does not listen to thread');
      if (!ticket.subscriptions.some((entry) => entry.source === source && entry.thread === thread))
        ticket.subscriptions.push({ source, thread, contextOnly: true });
    });
  }
  followup(id: string, text: string) {
    const prompt = triggerSchema.shape.text.parse(text);
    this.write((state) => {
      const ticket = this.ticket(state, id);
      if (['stopped', 'revoked'].includes(ticket.outcome ?? ''))
        throw new Error('Mandate withdrawn; start a new request');
      if (ticket.state === 'ended' && !this.validMandate(state, ticket))
        throw new Error('Mandate no longer holds under current policy');
      const trigger: Trigger = {
        id: randomUUID(),
        source: 'local',
        thread: ticket.id,
        actor: 'operator',
        actorKind: 'human',
        addressed: true,
        text: prompt,
      };
      state.triggers.push({ trigger, pending: false });
      state.decisions.push({
        id: randomUUID(),
        trigger,
        policyVersion: state.policy.version,
        outcome: 'delivered',
        ticketId: ticket.id,
        reason: 'Authenticated operator follow-up; original mandate applies',
      });
      ticket.inputs.push({
        id: randomUUID(),
        trigger,
        delivered: false,
        read: false,
        contextOnly: false,
      });
      ticket.state = 'open';
      ticket.outcome = undefined;
      if (ticket.assignments.at(-1)!.state === 'ended') this.assignment(state, ticket);
      ticket.report = undefined;
      if (!ticket.paused && ticket.assignments.at(-1)!.state === 'running')
        this.job(state, ticket, 'input', ticket.inputs.at(-1)!.id);
    });
  }
  report(id: string, assignmentId: string, input: WorkReport) {
    const report = workReportSchema.parse(input);
    this.write((state) => {
      const ticket = this.ticket(state, id);
      const assignment = ticket.assignments.at(-1)!;
      if (
        assignment.id !== assignmentId ||
        assignment.state === 'ended' ||
        ticket.state === 'ended'
      )
        return;
      ticket.report = report;
      if (report.status === 'progress') return;
      assignment.state = 'ended';
      state.jobs = state.jobs.filter((job) => job.ticketId !== id || job.kind === 'stop');
      if (report.status === 'ready' && !report.reviewRequired) {
        ticket.state = 'ended';
        ticket.outcome = 'completed';
      }
      if (report.status === 'dropped') {
        ticket.state = 'ended';
        ticket.outcome = 'dropped';
      }
      if (ticket.state === 'ended') this.releaseUnread(state, ticket);
      if (!['waiting', 'dropped'].includes(report.status))
        this.notice(
          state,
          ticket,
          report.status === 'ready' ? 'result' : 'attention',
          report.humanAction?.question ?? report.text,
        );
    });
  }
  inputsRead(id: string, inputIds: string[]) {
    this.write((state) => {
      const ticket = this.ticket(state, id);
      for (const input of ticket.inputs) if (inputIds.includes(input.id)) input.read = true;
    });
  }
  private releaseUnread(state: State, ticket: Ticket) {
    for (const input of ticket.inputs) {
      if (
        input.read ||
        input.contextOnly ||
        input.trigger.actorKind !== 'human' ||
        (input.trigger.source === ticket.mandate.source &&
          input.trigger.id === ticket.mandate.triggerId)
      )
        continue;
      input.contextOnly = true;
      const owned = state.tickets.some(
        (other) =>
          other.state === 'open' &&
          other.inputs.some(
            (entry) =>
              !entry.contextOnly &&
              entry.trigger.id === input.trigger.id &&
              entry.trigger.source === input.trigger.source,
          ),
      );
      if (!owned) {
        const record = state.triggers.find(
          (entry) =>
            entry.trigger.id === input.trigger.id && entry.trigger.source === input.trigger.source,
        );
        if (record) record.pending = true;
      }
    }
  }
  control(id: string, action: 'stop' | 'retry' | 'pause' | 'resume') {
    this.write((state) => {
      const ticket = this.ticket(state, id);
      if (ticket.state === 'ended')
        throw new Error('Ticket ended; send a new request or an in-scope follow-up');
      const assignment = ticket.assignments.at(-1)!;
      if (action === 'stop') {
        state.jobs = state.jobs.filter((job) => job.ticketId !== id);
        this.job(state, ticket, 'stop');
        ticket.state = 'ended';
        ticket.outcome = 'stopped';
        assignment.state = 'ended';
        this.releaseUnread(state, ticket);
      } else if (action === 'pause') {
        ticket.paused = true;
      } else if (action === 'resume') {
        ticket.paused = false;
        if (assignment.state === 'ended' && ticket.inputs.some((input) => !input.delivered))
          this.assignment(state, ticket);
        else if (assignment.state === 'running')
          for (const input of ticket.inputs.filter((input) => !input.delivered))
            this.job(state, ticket, 'input', input.id);
      } else {
        if (!ticket.deliveryError && !['failed', 'blocked'].includes(ticket.report?.status ?? ''))
          throw new Error('Ticket is not retryable');
        if (!this.validMandate(state, ticket))
          throw new Error('Mandate no longer holds under current policy');
        state.jobs = state.jobs.filter((job) => job.ticketId !== id);
        assignment.state = 'ended';
        this.assignment(state, ticket);
      }
    });
  }
  claim(id: string) {
    return this.write((state) => {
      const job = state.jobs.find((job) => job.id === id);
      if (!job || job.state !== 'pending' || job.nextAt > this.now()) return;
      const ticket = this.ticket(state, job.ticketId);
      if (job.kind !== 'stop' && (ticket.paused || ticket.state === 'ended')) return;
      job.state = 'running';
      if (job.kind === 'launch')
        job.inputIds = ticket.inputs.filter((input) => !input.delivered).map((input) => input.id);
      return job;
    });
  }
  complete(id: string) {
    this.write((state) => {
      const job = state.jobs.find((job) => job.id === id);
      if (!job) return;
      const ticket = this.ticket(state, job.ticketId);
      if (
        ticket.assignments.at(-1)!.id !== job.assignmentId ||
        (ticket.state === 'ended' && job.kind !== 'stop')
      ) {
        state.jobs = state.jobs.filter((entry) => entry.id !== id);
        return;
      }
      if (job.kind === 'launch') {
        ticket.assignments.at(-1)!.state = 'running';
        for (const input of ticket.inputs)
          if (job.inputIds?.includes(input.id)) input.delivered = true;
        for (const input of ticket.inputs.filter((input) => !input.delivered))
          this.job(state, ticket, 'input', input.id);
      }
      if (job.kind === 'input') {
        const input = ticket.inputs.find((input) => input.id === job.inputId);
        if (input) input.delivered = true;
        ticket.deliveryError = undefined;
      }
      state.jobs = state.jobs.filter((entry) => entry.id !== id);
    });
  }
  fail(id: string, error: string) {
    this.write((state) => {
      const job = state.jobs.find((job) => job.id === id);
      if (!job) return;
      job.attempts++;
      job.error = error.slice(0, 2000);
      // A launch may already have caused side effects; never blindly replay it.
      job.state = job.kind === 'launch' || job.attempts >= 3 ? 'failed' : 'pending';
      job.nextAt = this.now() + Math.min(60000, 2000 * 2 ** (job.attempts - 1));
      this.ticket(state, job.ticketId).deliveryError = job.error;
    });
  }
  recover() {
    this.write((state) => {
      for (const assessment of state.assessments?.filter((entry) => entry.state === 'pending') ??
        []) {
        assessment.state = 'unknown';
        state.accounting!.unknownCalls++;
        state.accounting!.unpricedCalls++;
      }
      for (const job of state.jobs.filter((job) => job.state === 'running')) {
        job.state = 'failed';
        job.error = 'Host restarted during delivery; inspect saved execution before retrying';
        this.ticket(state, job.ticketId).deliveryError = job.error;
      }
      for (const ticket of state.tickets.filter(
        (ticket) => ticket.state === 'open' && ticket.assignments.at(-1)?.state === 'running',
      )) {
        ticket.assignments.at(-1)!.state = 'ended';
        ticket.report = {
          status: 'blocked',
          text: 'Host restarted. Inspect saved files and history before retrying outside actions.',
          reviewRequired: false,
        };
      }
    });
  }
  handBack(id: string, source: string, triggerId: string, reason: string) {
    this.write((state) => {
      const ticket = this.ticket(state, id);
      const input = ticket.inputs.find(
        (input) => input.trigger.source === source && input.trigger.id === triggerId,
      );
      if (!input || input.contextOnly || input.trigger.actorKind !== 'human')
        throw new Error('Executor does not own this follow-up');
      if (
        input.trigger.source === ticket.mandate.source &&
        input.trigger.id === ticket.mandate.triggerId
      )
        throw new Error(
          'The original request defines this mandate; report blocked or dropped instead',
        );
      input.contextOnly = true;
      const stillOwned = state.tickets.some(
        (other) =>
          other.state === 'open' &&
          other.inputs.some(
            (entry) =>
              entry.trigger.source === source &&
              entry.trigger.id === triggerId &&
              !entry.contextOnly,
          ),
      );
      if (!stillOwned) {
        const record = state.triggers.find(
          (entry) => entry.trigger.source === source && entry.trigger.id === triggerId,
        )!;
        record.pending = true;
        state.decisions.push({
          id: randomUUID(),
          trigger: input.trigger,
          policyVersion: state.policy.version,
          outcome: 'ignore',
          reason: `Handed back: ${reason.slice(0, 1000)}`,
        });
      }
    });
  }
  reviewed(id: string) {
    this.write((state) => {
      const ticket = this.ticket(state, id);
      if (ticket.state !== 'open' || ticket.report?.status !== 'ready')
        throw new Error('Ticket is not awaiting review');
      ticket.state = 'ended';
      ticket.outcome = 'completed';
    });
  }
  attention() {
    return this.read().tickets.filter((ticket) => ticketStage(ticket).startsWith('person:'));
  }
}
