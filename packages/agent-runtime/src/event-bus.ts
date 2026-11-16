import { randomUUID } from 'node:crypto';
import {
  AgentError,
  redactText,
  taskPlanSchema,
  runSummarySchema,
  errorMessage,
  redact,
  type AgentEvent,
  type AgentState,
  type EventSink,
  type Task,
} from '@hikari/agent-core';

const transitions: Record<AgentState, readonly AgentState[]> = {
  idle: ['planning', 'failed', 'cancelled'],
  planning: ['thinking', 'paused', 'failed', 'cancelled'],
  thinking: ['waiting_permission', 'observing', 'paused', 'completed', 'failed', 'cancelled'],
  waiting_permission: ['executing_tool', 'observing', 'paused', 'failed', 'cancelled'],
  executing_tool: ['observing', 'failed', 'cancelled'],
  observing: ['thinking', 'waiting_permission', 'paused', 'completed', 'failed', 'cancelled'],
  paused: [
    'thinking',
    'waiting_permission',
    'executing_tool',
    'observing',
    'completed',
    'failed',
    'cancelled',
  ],
  waiting_input: ['observing', 'thinking', 'paused', 'failed', 'cancelled', 'interrupted'],
  interrupted: ['planning', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};
export class EventBus implements EventSink {
  private listeners = new Set<(event: AgentEvent) => void>();
  private critical = new Set<(event: AgentEvent) => void>();
  constructor(readonly task: Task) {}
  subscribe(listener: (event: AgentEvent) => void, options?: { critical?: boolean }) {
    this.listeners.add(listener);
    if (options?.critical) this.critical.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.critical.delete(listener);
    };
  }
  /** Execution has stopped; failed persistence must not strand the live UI as running. */
  reportFailure(error: unknown, state: 'failed' | 'cancelled' | 'interrupted' = 'failed') {
    this.task.status = state;
    try {
      this.emit('agent.state', { state });
    } catch {
      /* Report best-effort after fail-stop. */
    }
    try {
      this.emit(`agent.${state}`, { error: errorMessage(error) });
    } catch {
      /* Storage may remain unavailable. */
    }
  }
  emit(type: string, data: Record<string, unknown> = {}) {
    const event: AgentEvent = {
      id: randomUUID(),
      taskId: this.task.id,
      agentId: this.task.agentId,
      type,
      timestamp: new Date().toISOString(),
      data: redact(data) as Record<string, unknown>,
    };
    if (type === 'agent.state') {
      const next = data.state as AgentState;
      if (
        next !== this.task.status &&
        !(
          next === 'interrupted' && !['completed', 'failed', 'cancelled'].includes(this.task.status)
        ) &&
        !(
          next === 'waiting_input' &&
          ['planning', 'thinking', 'executing_tool', 'waiting_permission', 'observing'].includes(
            this.task.status,
          )
        ) &&
        !transitions[this.task.status].includes(next)
      )
        throw new AgentError('INVALID_TRANSITION', `${this.task.status} -> ${String(next)}`);
      this.task.status = next;
    }
    if (type === 'plan.updated') this.task.plan = taskPlanSchema.parse(event.data);
    if (type === 'agent.run.summary') this.task.runSummary = runSummarySchema.parse(event.data);
    this.task.updatedAt = event.timestamp;
    this.task.events.push(event);
    if (this.task.events.length > 2000) this.task.events.shift();
    let commitFailure: unknown;
    let failed = false;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        if (this.critical.has(listener) && !failed) {
          failed = true;
          commitFailure = error;
        }
        /* Presentation observers cannot break execution. Durable commits must. */
      }
    }
    if (failed)
      throw new AgentError(
        'EVENT_COMMIT_FAILED',
        redactText(`Event persistence failed: ${errorMessage(commitFailure)}`),
      );
  }
}
