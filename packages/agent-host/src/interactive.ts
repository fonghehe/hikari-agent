import type {
  Decision,
  PermissionRequest,
  RunOptions,
  Task,
  UserQuestion,
} from '@hikari/agent-core';
import { SessionHost, type SessionHostOptions } from './index';
import type { ControlAdapter } from './remote';

export class InteractiveSession implements ControlAdapter {
  readonly host: SessionHost;
  readonly root: string;
  private approvals = new Map<string, (decision: Decision) => void>();
  private questions = new Map<string, (answer: string) => void>();
  constructor(
    options: Omit<SessionHostOptions, 'approve' | 'requestUser'> & {
      policy?(request: PermissionRequest): Decision | undefined;
    },
  ) {
    this.root = options.root;
    this.host = new SessionHost({
      ...options,
      approve: async (request, signal) =>
        options.policy?.(request) ??
        this.pending(this.approvals, `${request.taskId}:${request.id}`, signal, 300000),
      requestUser: (question: UserQuestion, signal) =>
        this.pending(this.questions, question.id, signal),
    });
  }
  private pending<T>(
    map: Map<string, (value: T) => void>,
    key: string,
    signal: AbortSignal,
    timeoutMs = 3600000,
  ): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        map.delete(key);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason ?? new Error('Request cancelled'));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Interactive request expired'));
      }, timeoutMs);
      map.set(key, (value) => {
        cleanup();
        resolve(value);
      });
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  list() {
    return this.host.tasks.list().filter((task) => !task.delegated);
  }
  start(prompt: string, options: RunOptions, isolated: boolean) {
    return this.host.start(prompt, options, isolated);
  }
  async control(id: string, action: 'pause' | 'resume' | 'cancel') {
    const runner = this.host.runners.get(id);
    if (runner) {
      if (action === 'pause') runner.pause();
      if (action === 'resume') runner.resume();
      if (action === 'cancel') runner.cancel();
      return;
    }
    const saved = this.host.saved(id);
    if (
      !saved ||
      saved.delegated ||
      action !== 'resume' ||
      !['interrupted', 'paused'].includes(saved.status)
    )
      throw new Error(
        'Task is not running or resumable; inspect its parent task for delegated work',
      );
    return this.host.start(saved.prompt, saved.runOptions, false, saved);
  }
  input(id: string, text: string) {
    const runner = this.host.runners.get(id);
    if (!runner) throw new Error('Task is not running');
    runner.enqueue(text);
  }
  approve(taskId: string, requestId: string, decision: Decision) {
    const delegated = this.host.tasks
      .list()
      .find(
        (task) => task.parentTaskId === taskId && this.approvals.has(`${task.id}:${requestId}`),
      );
    const respond =
      this.approvals.get(`${taskId}:${requestId}`) ??
      (delegated ? this.approvals.get(`${delegated.id}:${requestId}`) : undefined);
    if (!respond) throw new Error('Approval expired');
    // This host has no persistent grant store. UI clients must not offer permanent grants.
    if (decision === 'always') throw new Error('Persistent approval is unavailable');
    respond(decision);
  }
  answer(taskId: string, questionId: string, answer: string) {
    const task: Task = this.host.tasks.get(taskId);
    if (task.pendingQuestion?.id !== questionId)
      throw new Error('Question does not belong to this task');
    const respond = this.questions.get(questionId);
    if (!respond) throw new Error('Question expired');
    respond(answer);
  }
  rewind(id: string, mode: 'code' | 'conversation' | 'both') {
    return this.host.rewind(id, mode);
  }
  close() {
    return this.host.close();
  }
}
