import type { ToolCall, ToolResult } from '@hikari/agent-core';

export type LifecycleEvent = 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'Stop';
export interface Lifecycle {
  dispatch(
    event: LifecycleEvent,
    signal: AbortSignal,
    call?: ToolCall,
    result?: ToolResult,
  ): Promise<void>;
}
