# Electron architecture

Hikari runs a main Electron window and optional conversation windows in one application instance. React calls a restricted preload bridge; main-process services own tasks, SQLite, files, terminals and external connections. AgentRunner currently executes in the main process. Attachment parsing uses a Worker; the agent as a whole is not a separate process.

## Process boundaries

```text
React / Zustand (renderer)
        ↓ window.hikari, typed by @hikari/shared
contextBridge (preload)
        ↓ ipcRenderer.invoke / subscriptions
IPC Router → domain handlers (main)
        ↓
TaskHost / LocalPersistence / TerminalSessions
        ↓
AgentRunner / providers / tools / Git / SQLite
```

| Layer           | Source                                           | Responsibility                                                                     |
| --------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Bootstrap       | `apps/desktop/src/main/index.ts`                 | Data location, instance lock, database migration, service composition and shutdown |
| Window          | `apps/desktop/src/main/window.ts`                | Window options, icon, navigation and permission policy, page loading               |
| IPC boundary    | `apps/desktop/src/main/ipc/router.ts`            | Owning-window and main-frame checks, handler disposal                              |
| Domain handlers | `apps/desktop/src/main/ipc/`                     | Workspace, models, tasks, changes and optional services                            |
| Bridge          | `apps/desktop/src/preload/index.ts`              | Explicit methods, event forwarding and unsubscribe functions                       |
| UI              | `apps/desktop/src/renderer/main.tsx`, `store.ts` | Drafts, task selection, event presentation and panels                              |
| Contract        | `packages/shared/src/index.ts`                   | `DesktopAPI`, DTOs and input schemas                                               |

Renderer code must not import main-process services, Node filesystem APIs or database connections. Keep business rules in services or shared packages; handlers validate requests and delegate.

## Startup and shutdown

1. Before readiness, resolve the data directory, set the application name and acquire the instance lock. A second launch focuses the existing window.
2. Migrate legacy SQLite data, initialize persistence and restore task records. Unfinished tasks become interrupted and wait for an explicit Resume.
3. Load preferences, create the window and Router, then restore decryptable model profiles through the model handlers.
4. Register handlers before loading the page. Development loading accepts only `http://127.0.0.1:5173`; otherwise load the built local page.
5. Before quitting, unregister IPC handlers and close the task host and terminals. Closing all windows exits the app on macOS as well; there is currently no Dock-only lifetime.

## Task execution

`agent:start` validates the prompt, run options and attachment IDs and passes the selected workspace to `TaskHost.start`. The host selects demo, conversation or project behavior, builds the provider, context, permissions, tools and optional worktree, then creates `AgentRunner`.

Events travel back over `agent:event` into the renderer store. The host also persists events, changes and checkpoints. `agent:control`, `agent:approve`, `agent:answer` and `agent:input` handle execution controls, approvals, pending questions and live instructions.

A follow-up creates a new turn with `parentTaskId`, related history and the same worktree. Resume restores the original task checkpoint. Keep those paths distinct; see [Run controls](run-controls.md).

## Adding an IPC operation

- `workspace.ts`: directory selection, recent projects, task file snapshots and attachment import/read.
- `models.ts`: profile restoration, protected credentials, activation, model lists and connection tests.
- `tasks.ts`: task lifecycle, import/export, memory, grants, Git review and worktree delivery.
- `services.ts`: MCP, Skills, updates, sync, browser previews and terminals.
- `index.ts`: composition, preferences, clipboard and external links.

Start with `DesktopAPI` and any required schemas. Add an explicit preload method and a domain handler through the Router. Channel names, argument tuples and return types derive from `DesktopAPI`; `RegisterHandler` checks each handler's synchronous or asynchronous result against that contract. Handler inputs remain `unknown` until validated at runtime. TypeScript cannot validate data crossing a process boundary. Handlers must retain state and permission checks. Add compile-only regression assertions in `tests/types/desktop-ipc.ts` when changing these types.

Subscriptions must return a cleanup function, called when their component unmounts. Do not expose a generic `invoke(channel, args)` or pass Electron event objects to renderer callbacks. `window.forge` remains a compatibility alias for older integrations; new code uses `window.hikari`.

## Window isolation and command sandboxing

Each window enables `contextIsolation` and renderer `sandbox`, disables `nodeIntegration`, denies renderer-created windows and navigation, and denies default-session permission requests. Conversation windows are created and registered by the main process. The Router accepts only registered windows and their main frames, retains the requesting window through asynchronous handlers with `AsyncLocalStorage`, and removes closed windows. Each window has its own selected workspace and native-dialog owner; task and terminal events reach all registered windows.

Renderer isolation is separate from the command OS sandbox in `packages/sandbox`. Interactive terminals run under the host account. MCP, browser and network operations retain their own approval rules.

## Native interaction and current limits

Application dialogs share `renderer/dialog.tsx`: ×, Escape, backdrop dismissal, focus restoration and a scrollable body. An open dialog must disable the background title bar's `-webkit-app-region: drag`. Otherwise a tall dialog's × can respond to DOM test clicks while real mouse input is intercepted by native window dragging.

SQLite operations are synchronous. Presentation events share short batches; execution boundaries and checkpoints flush immediately. Attachment parsing and OCR use a Worker, but orchestration, some indexing, vector ranking and database transactions still run in main. Collection bounds, result paging and batched writes limit cost; they are not a complete background-compute design or a large-scale vector index. Measure those paths before moving work to a Worker or utility process.

See [Development and verification](development.md) and [Data, memory and retrieval](memory-and-storage.md).

## Shared execution host

`packages/agent-host` composes the existing runtime, tools, permissions, MCP and Skills for CLI and workers. The desktop retains attachment and UI persistence ownership and shares `prepareCapabilities` for delegation, hooks, LSP and history. `ipc/platform.ts` validates schedule, plugin, configuration and history requests. Remote HTTP adapters expose only an explicitly selected project; the API service owns worker enrollment and durable execution leases, not local model credentials.
