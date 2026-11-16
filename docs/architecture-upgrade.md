# Application architecture and capability boundaries

The application uses one production composition root, `packages/agent-host/src/prepare-session.ts`. Desktop `TaskHost`, ordinary CLI runs, remote sessions and registered execution workers supply persistence, UI and permission adapters to it. Offline demo remains a simulation. The source-driven service adds proactive admission and routing to that same execution path.

## Request to deliverable

```text
Desktop / CLI / worker / Source event
        ↓ explicit request or versioned rule assessment
Policy → Mandate → Ticket → Assignment
        ↓ prepareAgentSession
Intent + scoped memory + current-source retrieval + capabilities
        ↓ AgentRunner
Model tool call → schema validation → permission → tool use → observation
        ↓ verification and structured report
Useful answer / reviewable changes / waiting / person needed
```

Direct desktop and CLI requests now receive the same explicit mandate and work identity as service execution. Desktop control state uses private SQLite `sessions` records partitioned by project/conversation. CLI control state uses atomic `.agent/state/superagent.json`. Task checkpoints remain in their existing stores. Imported conversations do not restore execution authority.

The desktop still owns attachments, native dialogs, multiple windows and change review. It does not own an alternative agent algorithm. Ordinary CLI runs use `SessionHost` instead of manually registering a separate set of tools. The service and remote worker use that host too. Delegated agents retain isolated contexts, restrictions and parent budget accounting.

## Capability audit

| Capability                  | Current implementation                                                                                                           | Boundary                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool calling                | OpenAI-compatible function calls, Anthropic `tool_use`, Gemini calls; streaming arguments execute only after completion          | Model/backend must support tools; a successful chat response does not establish tool support                                                       |
| Tool use                    | Runtime validation, permission checks, lifecycle events, cancellation, bounded observations and test evidence                    | A model cannot create host permissions; uncertain mutations are not blindly replayed                                                               |
| MCP                         | Configured stdio/HTTP connections; discovered tools, resources and prompts; lifecycle cleanup                                    | Connection approval is required; configured process execution uses the selected sandbox                                                            |
| Agent execution             | Shared session composition, explicit mandates, persistent work, delegation, optional development stages                          | No claim that multiple agents imply independent review quality                                                                                     |
| Intent                      | Initial routing from explicit run mode and workspace/conversation context; `route_intent` refines it                             | Research/plan/review can narrow tools; refinement cannot enable workspace execution or undo a restriction                                          |
| Working / short-term memory | Bounded context, observation archive, task summary, `update_working_memory`, private checkpoints                                 | Task-local working facts are not automatically promoted to long-term memory                                                                        |
| Conversation memory         | Separate conversation namespace with a seven-day default TTL for explicitly saved entries                                        | Another conversation cannot read it; follow-up history remains bounded                                                                             |
| Project memory              | Existing project facts/decisions, backward-compatible records, explicit remember/update/forget tools                             | Worktrees retain the original project's scope; an update cannot silently move memory between scopes                                                |
| User memory                 | Explicit `kind: user` entries, distinct from project and conversation scopes                                                     | Desktop SQLite shares these across projects. The file-backed CLI store is project-local; it does not silently write into a global home directory   |
| RAG                         | Structure-aware splitting, SQLite lexical/vector snapshots, embedding reuse, fusion, reranking and current-source citation reads | Exact vector search, not ANN; embeddings/reranking require configured services and approval                                                        |
| Project source RAG          | `search_project`, `search_project_local`, `index_project`, `read_project_source` over current documentation and code             | Max 200 files, 2 MB and 1,000 chunks per corpus; coverage reports partial indexing, excludes sensitive files and rejects traversal/stale citations |
| Native/browser tools        | Native PTY, file/Git tools, restricted execution and disposable Electron browser process                                         | Browser worker has no app IPC, credentials database or Node access in web pages                                                                    |

## Authorization and review

An explicit user request is the authority for an interactive execution; source-triggered inferred work needs a matching written rule and starts in observe mode. Both become work records. A completed model turn is independent of the work's review state. Changes are marked ready for review, and accepting/undoing all recorded changes closes the desktop work item. Questions can use the interactive input adapter; unattended source-driven execution uses report handoffs.

Intent routing is part of request interpretation, not authentication. External documents, MCP content, source events and memory remain reference data. They cannot change Policy, authorize publication or widen an immutable mandate. A refinement and a mutation cannot share one tool batch. A person's pause is persisted; shutdown wakes an aborted runner without recording a human resume.

## Packaging

See [desktop packaging](packaging.md). The release app is assembled from build-discovered runtime imports, not the whole workspace dependency tree. Browser automation reuses Electron's own Chromium in a separate disposable process. OCR and native tool support remain included and are exercised by the packaged-app smoke test.

## Design decisions

We retained the tested Hikari runner, attachment/RAG pipeline and sandbox instead of replacing the project with DeepSeek Harness. We removed duplicated production composition and adopted the public design's authorization, work/assignment separation, human attention and structured delivery principles throughout the app. Each host adapts its storage and interaction mechanism; it cannot omit those execution invariants.

SQLite fits desktop application state; atomic file state fits a project CLI. They implement the same control-store port, rather than making the desktop launch a second optional orchestration service. A single-project state document is bounded to 16 MB and needs archival before it fills. Multi-node durable routing, native Feishu intake and external notification delivery remain deployment-specific integration work, not capabilities implied by local fixture tests.

## Verification

`tests/integration/session-architecture.test.ts` exercises ordinary desktop/local entry points, typed memory isolation, project citations and intent restrictions. Existing provider/MCP, lifecycle, permissions, retrieval, checkpoint and delegation tests remain required. Run `pnpm check`, the full Playwright suite, `pnpm test:cli`, `pnpm desktop:pack` and `pnpm test:package`; use the [development guide](development.md) for platform prerequisites. Local fake providers establish protocol and runtime behavior, not live model relevance or real-account availability.

See [Agent reliability, evaluation and delivery](agent-readiness.md) for crash-safe transaction locks, recovery adapters, memory approvals, task benchmarks and accounting boundaries.

## Repository layout and dependency rules

Use this page as the current architecture and directory map. Process details remain in [Electron architecture](electron-architecture.md), [Superagent](superagent.md) and [reliability and evaluation](agent-readiness.md).

```text
apps/
  desktop/src/
    main/           # ipc, tasks, storage, attachments, browser, terminal
    preload/        # typed IPC bridge
    renderer/
      app/          # application composition and store
      features/     # conversations, workspace, settings, tools
      shared/       # components, preferences, i18n, ordered styles
  cli/              # interactive and service entry points
  server/           # remote control and worker transport
packages/
  agent-host/src/   # prepare-session, session-host, delivery, evaluation
  agent-runtime/src/
    runner/         # execution lifecycle and tool operations
    context/        # working context, saved memory, observations
    knowledge/      # indexing, retrieval, reranking, vector storage
    persistence/    # checkpoints, state, traces, workspace ownership
    orchestration/  # superagent control, delegation, workflows, scheduling
  shared/src/       # models, attachments, workspace, preferences, changes, desktop-api
  ...               # core, providers, tools, sandbox, MCP, storage, skills, UI
integrations/       # external adapters
scripts/            # build, release, checks, evals, benchmarks, shared helpers
tests/             # domain suites, integration, e2e, fixtures, type assertions
docs/              # current English, Chinese and Japanese guides
.artifacts/         # ignored reports, package staging and releases
```

Public `index.ts` files contain exports; implementations live in their domains. Internal imports target implementation files to avoid barrel cycles; cross-package imports use declared `@hikari/*` exports. Existing public exports remain compatible. Consumers of model configuration can use `@hikari/shared/models` without importing desktop contracts. Renderer uses the preload contract for privileged operations and does not import Node or main. `shared/styles/index.css` loads the split stylesheets in their original cascade order.

Tests are grouped into `runtime`, `knowledge`, `desktop`, `providers`, `tools`, `platform`, `storage`, `security`, `evals` and `integration`. `e2e`, `fixtures` and `types` retain end-to-end tests, shared fixtures and type assertions. Declare test dependencies at the root; never import another package's private `node_modules`.

`pnpm typecheck` checks renderer, main/preload, Node services and tooling/tests separately. Strict options live in `tsconfig.base.json`; renderer has no Node ambient types. The root `tsconfig.json` remains available for editors and direct compatibility checks.

## Generated files and cleanup

Reports use `.artifacts/test-results`; desktop staging uses `.artifacts/package/desktop`; desktop releases use `.artifacts/releases/desktop`; VSIX files use `.artifacts/releases/vscode`. App compilation still uses `dist`, and tool caches retain `.turbo` and `.cache`. Existing release files and reports can be relocated without deleting runtime data.

`pnpm clean:build`, `pnpm clean:reports` and `pnpm clean:cache` preview exact targets by default. Append `--apply` to remove them. Cleanup rejects symbolic-link paths and only allows fixed generated directories; it preserves releases, dependencies, `.agent`, shared Agent instructions, local skills and historical records. Skill adapter links such as `.claude` continue to reference `.agents/skills`.
