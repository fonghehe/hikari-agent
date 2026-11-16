# Superagent supervision

Hikari's local service can receive authorized work, assign an isolated executor, retain the work across turns and show the decisions that need a person. Start it with `pnpm agent serve`; ordinary desktop, CLI and worker execution now share the same session composition and work authorization. See [application architecture](architecture-upgrade.md).

## Design reference

This implementation follows the published [DeepSeek Superagent research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), reviewed on 2026-11-13: [principle](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md), [domain](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md), [authorization](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md), [execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md) and [panel](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/005-panel.md). DeepSeek describes it as research code, with differences from its internal implementation and some article designs still unimplemented.

The practical principle is to spend human attention only on useful results and required decisions. The router decides whether work is authorized; the executor inspects, implements and verifies it. Messages and retrieved documents supply context, never permission.

```text
Source → immutable Trigger → gate / rule assessment → Decision
                                            ↓ accept
                                Ticket + immutable Mandate
                                            ↓ Assignment
                                 Hikari executor + worktree
                                            ↓ structured report
                                waiting / ready / needs a person
```

| Concept            | Hikari implementation                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Source / Thread    | The local operator and configured event streams; identities are scoped to their Source                                        |
| Trigger / Decision | An event ID unique within a Source, immutable event content and a persisted admission decision                                |
| Policy / Mandate   | Versioned source lists and written rules; every acceptance records its original actor, scope, version and matched rule text   |
| Ticket             | Authorized work with its own state, subscriptions, inputs and reports                                                         |
| Assignment         | One execution turn, bound to a distinct saved runtime Task; later turns retain the ticket and isolated directory              |
| Subscription       | Context fan-out; a human follow-up on an owned thread belongs to its executor, while context-only subscriptions grant nothing |
| Channel            | Persisted local acknowledgement, result or attention notices with their original source/thread address                        |

## Start and supervise

Configure a model using the [CLI environment variables](cli.md), then run:

```sh
AGENT_WORKSPACE=/absolute/path/to/project pnpm agent serve 4319
```

Open the printed loopback URL and enter its access token. The page keeps the token in that tab's session storage. **Start** submits a local request from the authenticated operator. Execute requests use an isolated worktree by default; Plan requests stay read-only and do not create a worktree. A repository needs at least one commit to create a worktree; ignored dependencies are not copied.

**Needs your attention** contains undelivered inputs, required answers or tool approvals, paused work, blocked/failed work and ready results awaiting review. Working and event-waiting tickets stay in **Work**. **Needs evaluation** lets you retry an unavailable assessment. The intake history records ignored candidates and observe-mode decisions without generating extra notices.

Use **View diff** to inspect a deliverable and **Mark reviewed** to close its ticket. This records review only; it does not apply a patch, merge a branch or publish. A completed executor turn can therefore leave its ticket awaiting review. Changed files always require review even if the executor did not request it.

Additional instructions continue the same ticket under its original scope. A stopped ticket's authorization is withdrawn; start a new request to authorize work again. Pause persists across new messages and restarts until an operator resumes it.

## Explicit requests and proactive rules

The initial policy has one Source, `local`, with the allowed actor `operator`. Its mode is **observe**. Allowed humans addressing the agent explicitly can start work in every mode. Listed bots can only produce inferred candidates; unknown bots and unlisted people cannot originate new work. An existing ticket receives subscribed messages as context regardless of their author, within its original mandate.

| Mode                | Inferred work                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `off`               | Ignored                                                                                                          |
| `observe` (default) | Assess every enabled rule once; record “would accept” when a rule matches; create no executor or acknowledgement |
| `auto`              | Accept only after a valid assessment matches at least one enabled written rule                                   |

With no enabled rule, inferred work is ignored without a model assessment. The assessor receives no tools. Invalid or failed assessments record `unavailable`; they never start work. A stale assessment cannot authorize against a newer policy. Rule assessment uses the configured model and can consume model tokens separately from executor budgets; cap that provider account's usage when operating a public event stream.

Policy saves require the current `baseVersion`, create a new immutable version and retain previous versions. Live tickets receive policy changes as context; they keep their original mandate. Before ended tickets resume, the host checks whether the Source still listens and the original authorization still holds. Inferred mandates additionally require `auto` and the same enabled matched rules.

## Event integration API

The local service exposes these routes under the existing Bearer-token and same-origin checks:

| Route                                    | Operation                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /api/superagent`                    | Policy history, triggers, decisions, tickets, assignments, notices and attention projection |
| `POST /api/superagent/request`           | `{prompt, options?, isolated?}`: explicit local operator request                            |
| `POST /api/superagent/policy`            | `{baseVersion, policy}`: operator-only policy update                                        |
| `POST /api/superagent/triggers`          | A trusted Source adapter submits the event below                                            |
| `POST /api/superagent/reevaluate`        | `{source, triggerId}`: retry an unowned unavailable/ignored event                           |
| `POST /api/superagent/tickets/:id`       | `{action}`: `pause`, `resume`, `stop`, `retry` or `reviewed`                                |
| `POST /api/superagent/tickets/:id/input` | `{text}`: authenticated operator follow-up within the mandate                               |

An example policy, supplied as `policy` alongside the current `baseVersion`:

```json
{
  "mode": "observe",
  "sources": [
    { "id": "local", "allowedActors": ["operator"], "threads": ["*"] },
    {
      "id": "github:team/project",
      "allowedActors": ["maintainer"],
      "bots": ["ci[bot]"],
      "threads": ["*"],
      "receiveAll": true
    }
  ],
  "rules": [
    {
      "id": "failed-ci",
      "instruction": "Investigate a failed CI check in team/project and produce a local fix with passing tests for review. Do not push or merge."
    }
  ]
}
```

```json
{
  "id": "stable-provider-delivery-id",
  "source": "github:team/project",
  "thread": "pull:42",
  "actor": "ci[bot]",
  "actorKind": "bot",
  "addressed": false,
  "text": "CI failed: parser regression in tests/parser.test.ts"
}
```

This ingress is an **operator API**, not an unauthenticated webhook. An adapter must verify its upstream signatures, derive actor identity/kind and addressing from provider metadata, discard its own bot messages, restrict repositories, persist its read position and reuse stable event IDs. Never give the operator token to outside message authors. Submitting an ID with changed content is rejected; identical redelivery returns the stored decision.

## Execution and recovery

Executors retain existing sandbox approvals, token/time budgets, lifecycle hooks, MCP, retrieval and deterministic acceptance. Authorization to start work does not grant filesystem, command, network or publication permission. `report_work` records `progress`, `waiting`, `ready`, `blocked`, `failed` or `dropped`. A `blocked` report can carry one `humanAction.question`. Waiting, blocked, failed and dropped reports end that execution turn and free its resources; `ready` still passes through existing acceptance checks. Report and mutation calls cannot share a batch.

`read_source_event` reads full input text when a live card is truncated. `hand_back` returns an owned follow-up for fresh assessment when it belongs to separate work. `follow_thread` adds context-only subscriptions. Human follow-ups stay with their executor until handed back or released unread at ticket end. Bot messages cannot resume ended tickets, and automatic input cannot wake blocked or failed executors.

The host persists domain changes and queued launch/input/stop intents together in `.agent/state/superagent.json`. A process lease prevents two Superagent hosts owning the same project. Runtime Tasks and their checkpoints remain in `.agent/runs/`; model credentials remain in the existing provider configuration. Input delivery is distinct from the runner consuming it. Unread inputs are retained for another assignment. Policy history, notices and audit records contain source text: treat this project-local state as private, back it up and do not commit it.

The default is three live executors, with one extra slot for a continuation of existing work. Structured report handoffs release their slot. A paused live turn or tool approval wait retains its resources, slot and deadline; supervised executors use report handoffs instead of `ask_user` for decisions. Ticket control tools are not inherited by delegated workers. Input deliveries back off from two seconds and surface repeated failures. Launch failures and uncertain in-flight work are held for inspection. After restart, working tickets become blocked rather than blindly replaying outside actions. **Retry** starts another assignment, retains the directory and supplies the previous result and bounded conversation as context. This does not resume the old model transcript or share a cumulative ticket budget: each assignment has its own run limits. Inspect current files and external state before retrying uncertain operations.

## Architecture decision and boundaries

The domain contracts are in `packages/agent-core/src/superagent.ts`; `SuperagentEngine` in `agent-runtime` is the only domain writer. `SuperagentSession` in `agent-host` connects it to the existing `SessionHost` executor; `RemoteControlServer` and the CLI are adapters. No new orchestration dependency is needed.

We retain Hikari's executor, sandbox and storage rather than replacing them with DeepSeek Harness. This keeps local model profiles, attachment/RAG support, existing checkpoints and verification behavior. A separate ticket layer avoids treating a model turn's completion as the completion of a reviewed deliverable. Atomic local state fits a single-project service; it is bounded to 16 MB and is not a multi-node queue. Archive/back up old project state before exhausting it; do not delete active records to recover space.

This is an adaptation of the public design, not a full port. Native Feishu/GitHub polling and outbound delivery, automatic PR close/merge tracking, automatic restart of interrupted assignments, a general admission table, cross-ticket attachment routing and prompt editing/version UI are not implemented in this supervision service. Notices are delivered locally through the authenticated API/panel; no external account is contacted for them. The existing self-hosted GitHub/CI worker route and scheduled jobs remain separate, explicitly configured execution paths. Desktop conversations and `/api/tasks` now adopt explicit user requests into the same work domain through the shared session composition; their native UI and storage remain adapters. The CLI service page and `/api/superagent/*` additionally expose source-driven admission, history and supervision.

Regression coverage lives in `tests/runtime/superagent.test.ts`, `tests/integration/superagent-host.test.ts` and `tests/e2e/superagent.spec.ts`. Run [the standard verification commands](development.md); fixture tests do not establish live-model rule-assessment quality or production connector reliability.
