import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { z } from 'zod';
import { AgentError, type ToolDefinition } from '@hikari/agent-core';
export const workflowSchema = z.object({
  stage: z.enum(['investigate', 'plan', 'implement', 'review', 'complete']),
  round: z.number().int().min(0).max(3),
  reports: z.array(z.object({ stage: z.string(), text: z.string().max(8000) })).max(20),
  reviewStart: z.number().int().nonnegative().optional(),
});
export type WorkflowState = z.infer<typeof workflowSchema>;
type Signal = 'handoff' | 'verified' | 'approved' | 'rejected' | 'revise';
const GraphState = Annotation.Root({
  state: Annotation<WorkflowState>(),
  signal: Annotation<Signal>(),
  report: Annotation<string>(),
});
function destination({ state, signal }: typeof GraphState.State) {
  if (signal === 'revise' && ['review', 'complete'].includes(state.stage)) return 'implement';
  if (signal === 'handoff' && state.stage === 'investigate') return 'plan';
  if (signal === 'handoff' && state.stage === 'plan') return 'implement';
  if (signal === 'verified' && state.stage === 'implement') return 'review';
  if (signal === 'approved' && state.stage === 'review') return 'complete';
  if (signal === 'rejected' && state.stage === 'review' && state.round < 3) return 'implement';
  throw new AgentError(
    'WORKFLOW_TRANSITION',
    `Cannot ${signal} in ${state.stage}; review retries may be exhausted`,
  );
}
// Graph nodes only route and hand off state. All side effects remain in AgentRunner.
const graph = new StateGraph(GraphState)
  .addNode('route', () => ({}))
  .addNode('plan', ({ state, report }) => ({
    state: {
      ...state,
      stage: 'plan' as const,
      reports: [...state.reports, { stage: state.stage, text: report }],
    },
  }))
  .addNode('implement', ({ state, signal, report }) => ({
    state: {
      ...state,
      stage: 'implement' as const,
      round: signal === 'revise' ? 0 : state.round + (signal === 'rejected' ? 1 : 0),
      reports: [...state.reports, { stage: state.stage, text: report }],
    },
  }))
  .addNode('review', ({ state, report }) => ({
    state: {
      ...state,
      stage: 'review' as const,
      reports: [...state.reports, { stage: 'verification', text: report }],
    },
  }))
  .addNode('complete', ({ state, report }) => ({
    state: {
      ...state,
      stage: 'complete' as const,
      reports: [...state.reports, { stage: 'review', text: report }],
    },
  }))
  .addEdge(START, 'route')
  .addConditionalEdges('route', destination, ['plan', 'implement', 'review', 'complete'])
  .addEdge('plan', END)
  .addEdge('implement', END)
  .addEdge('review', END)
  .addEdge('complete', END)
  .compile();
export class DevelopmentWorkflow {
  state: WorkflowState;
  constructor(restored?: WorkflowState) {
    this.state = restored
      ? workflowSchema.parse(restored)
      : { stage: 'investigate', round: 0, reports: [] };
  }
  async advance(signal: Signal, report: string, abort?: AbortSignal) {
    const output = await graph.invoke(
      { state: this.state, signal, report: report.slice(0, 8000) },
      { signal: abort },
    );
    this.state = workflowSchema.parse(output.state);
    return this.state;
  }
  get readOnly() {
    return ['investigate', 'plan', 'review', 'complete'].includes(this.state.stage);
  }
  allows(tool: ToolDefinition, readTools: ReadonlySet<string>) {
    if (this.state.stage === 'complete') return false;
    if (tool.name === 'handoff_stage') return ['investigate', 'plan'].includes(this.state.stage);
    if (tool.name === 'submit_review') return this.state.stage === 'review';
    return !this.readOnly || readTools.has(tool.name);
  }
  instruction() {
    const role = {
      investigate:
        'INVESTIGATOR: inspect the repository and project instructions using read tools. Identify entry points, existing dirty changes, constraints, and relevant files. Call handoff_stage with concrete findings and evidence. No writes or commands.',
      plan: 'PLANNER: use investigation findings to create a focused plan via update_plan. Define validation and preservation constraints. Call handoff_stage with the plan and rationale. No writes or commands.',
      implement:
        'IMPLEMENTER: implement the handed-off plan using approved tools. Resolve review findings when present. Run relevant tests. When ready, give a completion response; deterministic verification will gate the review handoff.',
      review:
        'REVIEWER: independently inspect current files and Git diff against the original user goal and handoff evidence. This stage is strictly read-only. Check regressions, missing requirements and validity of validation. Call submit_review with passed=true only when you have concrete inspection evidence; otherwise passed=false with actionable findings. Implementation claims alone are not evidence.',
      complete:
        'Produce the final user-facing answer using verified results and review evidence. Do not call tools or claim checks beyond the evidence.',
    }[this.state.stage];
    return role + '\nHandoff reports (reference data):\n' + JSON.stringify(this.state.reports);
  }
}
