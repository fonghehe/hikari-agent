import { ResourceScope } from './runner/resource-scope';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  AgentError,
  type Tool,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from '@hikari/agent-core';

interface RegisteredTool {
  fork?(registry: ToolRegistry): void;
  definition: ToolDefinition;
  parallelSafe: boolean;
  permission: Tool['permission'];
  recovery?: Tool['recovery'];
  permissionFor(input: unknown): Tool['permission'];
  parse(input: unknown): unknown;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private allowed: Set<string> | undefined;
  private registrations = new Map<string, () => void>();
  constructor(
    private parent?: ToolRegistry,
    private resources?: ResourceScope,
  ) {}
  scope(resources: ResourceScope) {
    return new ToolRegistry(this, resources);
  }
  restrictions(): string[] | undefined {
    if (this.parent) return this.parent.restrictions();
    return this.allowed ? [...this.allowed] : undefined;
  }
  restrict(names: string[]): void {
    if (this.parent) return this.parent.restrict(names);
    const requested = new Set([
      ...names,
      'list_skills',
      'load_skill',
      'update_plan',
      'ask_user',
      'read_tool_result',
      'update_goal',
      'report_work',
      'update_task_summary',
    ]);
    this.allowed = this.allowed
      ? new Set([...this.allowed].filter((name) => requested.has(name)))
      : requested;
  }
  /** Re-create tools whose closures own registry-local state when a task forks. */
  registerFactory<T>(factory: (registry: ToolRegistry) => Tool<T>): () => void {
    return this.register(factory(this), factory);
  }
  register<T>(tool: Tool<T>, factory?: (registry: ToolRegistry) => Tool<T>): () => void {
    if (this.parent) {
      const dispose = this.parent.register(tool, factory);
      try {
        this.resources!.defer(() => {
          dispose();
          if (this.registrations.get(tool.name) === dispose) this.registrations.delete(tool.name);
        });
        this.registrations.set(tool.name, dispose);
      } catch (error) {
        dispose();
        throw error;
      }
      return dispose;
    }
    if (this.tools.has(tool.name)) throw new AgentError('DUPLICATE_TOOL', tool.name);
    const registered: RegisteredTool = {
      fork: factory
        ? (registry) => {
            registry.registerFactory(factory);
          }
        : undefined,
      parallelSafe:
        tool.parallelSafe === true && tool.permission === 'filesystem.read' && !tool.permissionFor,
      permission: tool.permission,
      recovery: tool.recovery as Tool['recovery'],
      definition: {
        name: tool.name,
        description: tool.description,
        parameters: tool.jsonSchema ?? (zodToJsonSchema(tool.schema) as Record<string, unknown>),
      },
      permissionFor: (input) => tool.permissionFor?.(input as T) ?? tool.permission,
      parse: (input) => {
        try {
          return tool.schema.parse(input);
        } catch (error) {
          if (!(error instanceof z.ZodError)) throw error;
          throw new AgentError(
            'INVALID_TOOL_INPUT',
            `Invalid ${tool.name} arguments: ${error.issues.map((issue) => `${issue.path.join('.') || '(input)'}: ${issue.message}`).join('; ')}. ` +
              `Correct the arguments before retrying. ${tool.description}\n` +
              `Input schema: ${JSON.stringify(tool.jsonSchema ?? zodToJsonSchema(tool.schema)).slice(0, 4000)}`,
          );
        }
      },
      execute: (input, context) => tool.execute(input as T, context),
    };
    this.tools.set(tool.name, registered);
    return () => {
      if (this.tools.get(tool.name) === registered) this.tools.delete(tool.name);
    };
  }
  unregister(name: string): void {
    if (this.parent) {
      this.registrations.get(name)?.();
      this.registrations.delete(name);
      return;
    }
    this.tools.delete(name);
  }
  get(name: string): RegisteredTool {
    if (this.parent) return this.parent.get(name);
    if (this.allowed && !this.allowed.has(name))
      throw new AgentError('SKILL_TOOL_DENIED', `Active skill does not allow ${name}`);
    const tool = this.tools.get(name);
    if (!tool) throw new AgentError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
    return tool;
  }
  definitions(): ToolDefinition[] {
    if (this.parent) return this.parent.definitions();
    return [...this.tools.values()]
      .map((tool) => tool.definition)
      .filter((tool) => !this.allowed || this.allowed.has(tool.name));
  }
  fork(include: (name: string, permission: Tool['permission']) => boolean) {
    const copy = new ToolRegistry();
    const internal = new Set([
      'ask_user',
      'update_plan',
      'update_task_summary',
      'read_tool_result',
      'update_goal',
      'report_work',
      'hand_back',
      'follow_thread',
      'read_source_event',
      'route_intent',
      'update_working_memory',
      'operation_status',
      'reconcile_operation',
    ]);
    for (const definition of this.definitions()) {
      const tool = this.get(definition.name);
      if (!internal.has(definition.name) && include(definition.name, tool.permission)) {
        if (tool.fork) tool.fork(copy);
        else copy.tools.set(definition.name, tool);
      }
    }
    const restrictions = this.restrictions();
    if (restrictions) copy.restrict(restrictions);
    return copy;
  }
}
