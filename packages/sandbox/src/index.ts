import {
  AgentError,
  type PermissionManager as PermissionContract,
  type PermissionRequest,
  type Decision,
  type EventSink,
} from '@hikari/agent-core';
export { LogicalSandboxProvider, type SandboxProvider } from './logical';
export interface GrantStore {
  has(key: string): boolean;
  add(key: string): void;
}
export class PermissionManager implements PermissionContract {
  constructor(
    private events: EventSink,
    private requestApproval: (request: PermissionRequest, signal: AbortSignal) => Promise<Decision>,
    private persistent?: GrantStore,
    private session = new Set<string>(),
  ) {}
  async check(request: PermissionRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    if (request.permission === 'shell.system') return false;
    if (['filesystem.read', 'filesystem.write'].includes(request.permission)) return true;
    const key = JSON.stringify([
      request.workspace,
      request.tool,
      request.permission,
      request.input,
    ]);
    if (this.session.has(key) || this.persistent?.has(key)) return true;
    this.events.emit('permission.requested', { request });
    const decision = await this.requestApproval(request, signal);
    signal.throwIfAborted();
    if (decision === 'session') this.session.add(key);
    if (decision === 'always') {
      if (!this.persistent)
        throw new AgentError(
          'PERSISTENCE_UNAVAILABLE',
          'Persistent permission storage is unavailable',
        );
      this.persistent.add(key);
    }
    this.events.emit(decision === 'deny' ? 'permission.denied' : 'permission.approved', {
      id: request.id,
      decision,
    });
    return decision !== 'deny';
  }
}
export { runProcess, type ProcessOptions } from './process';

export { NativeSandboxProvider, type ProcessLaunch } from './native';
