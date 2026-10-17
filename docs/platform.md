# Automation, agents and integrations

Hikari's local runtime, desktop UI and CLI share these capabilities. Remote execution uses your own registered machines or servers. You supply the model, language servers and hosting; installing Hikari does not provision a managed cloud account.

## Delegated agents

On real workspace tasks, the model can call `spawn_agent`, `wait_agent`, `send_agent_message` and `cancel_agent`. Ask it to delegate independent investigations and return each worker's evidence. Each worker has a separate context and inherits the parent's tool restrictions. There can be three active workers and twelve delegations per run. Nested delegation is unavailable.

Workers are read-only by default. Setting `writable: true` creates a Git worktree including the current uncommitted files. Each worker owns its changes there; it cannot silently deliver them into the parent's workspace. Review the returned worktree and use the existing delivery workflow or Git. Dependencies and ignored files are not copied.

The parent reserves part of its remaining token and cost allowance for each worker, charges actual worker usage and waits for workers before accepting completion. Cancelling or interrupting the parent interrupts workers. Interrupted work is retained and is never automatically replayed. Plan mode does not permit delegation or hidden write tools.

Plugins can supply named roles, such as the `project-review-reviewer` role in `examples/plugin`. These are role instructions and permission limits, not a guarantee of review quality.

## Lifecycle hooks

Open **Project chats → Memory & extensions → Automation and integrations → Lifecycle hooks**, or create `.agent/hooks.json`:

```json
[
  {
    "id": "format-source",
    "event": "PostToolUse",
    "tool": "apply_patch",
    "command": "node",
    "args": ["scripts/format.mjs"],
    "timeoutMs": 30000
  }
]
```

Supported events are `SessionStart`, `PreToolUse`, `PostToolUse` and `Stop`. The optional `tool` field matches an exact tool name. Commands receive bounded JSON on stdin containing the event, task ID, tool call and result. No shell interpolation is performed. A denied command, nonzero exit or timeout blocks the operation. Before-tool failures prevent that tool from running. Post-tool failures cannot undo an operation that already happened.

Hooks use the task's command sandbox and approval policy. Their edits appear in change history and invalidate older test evidence. Stop hooks run before final acceptance checks. Hooks are disabled during Plan and the read-only development stages; session hooks start when execution becomes writable. Configuration changes affect new runs. Unattended runs still need suitable saved permissions or an explicit command policy.

## Scheduled tasks and monitors

Use **Project chats → Memory & extensions → Automation and integrations → Scheduled tasks** to create a recurring task or choose a single future time. The desktop keeps schedules for explicitly registered workspaces and uses the selected model profile. Keep the app and computer running. Notifications can cover changed results and failures, every run, or failures only. A monitor prompt should define what constitutes an actionable change and use a stable response when nothing changed.

The CLI uses the same durable schedule format:

```json
{
  "name": "Review project changes",
  "prompt": "Inspect the current project. Report actionable changes; respond No changes when none require attention.",
  "cadence": { "kind": "interval", "minutes": 60 },
  "isolated": false,
  "notify": "changes",
  "options": { "mode": "plan", "maxTokens": 40000, "maxDurationMs": 300000 }
}
```

Save this outside private run storage, for example as `schedule.json`, then run:

```sh
pnpm agent schedule add schedule.json
pnpm agent schedule list
pnpm agent schedule run
# Other controls: schedule pause ID / resume ID / remove ID
```

Other cadences are `{"kind":"once","at":"2026-12-01T01:00:00Z"}` and `{"kind":"cron","expression":"0 9 * * 1-5","timezone":"Asia/Shanghai"}`. Cron has five fields, supports lists, ranges and steps, and uses weekdays 0–6. Local-time schedules follow the configured timezone, including daylight-saving changes. An unavailable occurrence within the next year is rejected.

Only one scheduler owns a project at a time. Runs do not overlap for the same schedule, and missed recurring occurrences are coalesced. A run interrupted by a crash is disabled on recovery: inspect its saved task before re-enabling it. No missed side effect is automatically replayed. The desktop and a CLI daemon should not both own the same project. CLI notifications are JSON events. In unattended CLI execution, commands default to denied; `HIKARI_ALLOWED_COMMANDS='["node"]'` explicitly permits that executable inside the selected sandbox, including scripts passed to it.

## Language servers

Install the server for your language first, then configure **Language servers** in workspace settings, or `.agent/lsp.json`:

```json
[
  {
    "name": "typescript",
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "extensions": [".ts", ".tsx", ".js", ".jsx"],
    "languageId": "typescript"
  }
]
```

After approval, Hikari starts a stdio Language Server Protocol process. The model gets `lsp_definition`, `lsp_references`, `lsp_hover` and `lsp_diagnostics`; positions are zero-based. Current file text is sent before each lookup. Servers are closed after a task. Servers cannot request client-side file edits, and locations outside the workspace are withheld.

Language servers need command approval and are unavailable in Plan mode. Diagnostics depend on the server and project configuration. Servers without pull diagnostics fall back to published results, which may still be pending. This is not a substitute for running the project's compiler or tests. On Windows, the server and toolchain must be available in the sandbox's Linux image; host-installed binaries are not automatically copied into it.

## VS Code integration

The extension lives in `integrations/vscode`. Package it with `pnpm vscode:pack`, then use **Extensions → Install from VSIX** to install `release/hikari-workspace-0.1.0.vsix`.

Start remote control for the same workspace from the desktop, or run:

```sh
pnpm agent serve 4319
```

Run **Hikari: Connect to Local Host** in VS Code and enter the URL and access token. The token is saved in VS Code SecretStorage. The **Hikari Tasks** view supports starting tasks, reading results, pausing, resuming, cancelling, sending instructions, responding to questions and approvals, and opening the current task diff.

New tasks can include the selected text, its file path and current editor diagnostics. Unsaved content is marked as such; it does not replace the on-disk file. The editor and host must use the same project. Untrusted workspaces cannot start tasks. A JetBrains extension is not included; its external tools can invoke the CLI.

## Remote control from another device

Open **Remote control** in workspace settings. By default the service binds only to `127.0.0.1:4319`. Copy the token, open the panel and connect. The panel operates on the same live tasks, including approvals and questions. It is separate from snapshot synchronization.

For another device, use an HTTPS reverse proxy or an SSH tunnel. The desktop's **Listen on the local network** setting binds `0.0.0.0`; replace that address with the computer's actual LAN hostname/IP. The CLI equivalent is `HIKARI_REMOTE_HOST=0.0.0.0 pnpm agent serve 4319`. The token grants control of the selected project, so keep it private. Stopping the service invalidates its generated token. CLI deployments can pin a token through `HIKARI_REMOTE_TOKEN` (at least 32 characters).

The API uses `Authorization: Bearer TOKEN`, never a token in the URL. It checks browser origins and exposes only the configured project. The host must stay on. Reconnect after interruption and inspect the saved task before resuming. The CLI also serves `/api/tasks`, task `control/input/approve/answer/diff` routes, `/api/automations`, `/api/timeline` and `/api/rewind`; the VS Code extension uses this API.

## Self-hosted cloud execution

Run the API service on a server with Node 24 and the project dependencies. `pnpm server` starts it locally; put HTTPS in front of any publicly reachable deployment. Configure `SQLITE_PATH` or `DATABASE_URL`; Redis remains optional. Open `/execution` for the responsive job console. Sign in using an account created through the existing account/sync flow or `/auth/register`.

Prepare a separate execution machine with Git, ripgrep, a real model configuration and the platform sandbox. Map public project aliases to pre-provisioned local checkouts:

```sh
export HIKARI_SERVER_URL='https://hikari.example.com'
export HIKARI_WORKER_PROJECTS='{"my-project":"/srv/projects/my-project"}'
export HIKARI_ACCOUNT_TOKEN='token returned by /auth/login'
pnpm agent worker register build-machine
```

Registration returns `workerToken`; keep it on the worker, not in the repository. Set `HIKARI_WORKER_TOKEN` to that value and start `pnpm agent worker run`. `--once` processes at most one job for diagnostics. Configure the model through the same `AGENT_*` variables as the regular CLI. Browser use additionally requires Chromium. Commands not covered by `HIKARI_ALLOWED_COMMANDS` wait for an explicit remote approval.

In `/execution`, select the worker and project, submit a task, inspect results and respond to requests. The server never accepts an arbitrary host path or model key in a job. Each worker is scoped to its owning account and registered aliases. Worker credentials can be revoked with authenticated `DELETE /execution/workers/ID`.

Jobs have exclusive, expiring execution leases. Updates renew the lease, commands remain queued until acknowledged, and an expired execution becomes interrupted rather than being reassigned. Private checkpoints remain on the execution machine; the server gets bounded, redacted presentation snapshots. Worktrees stay on that machine for inspection and delivery. Restarting a job does not silently replay earlier effects. The cloud server keeps running when your personal laptop is off, provided its worker stays running.

Workers normally use the OS sandbox. For a dedicated Docker worker, `HIKARI_WORKER_EXECUTION=container` permits host-mode commands only when `/.dockerenv` is present; in that mode the dedicated container is the execution boundary. Never mount unrelated host files or credentials into it. Network access also requires `HIKARI_WORKER_ALLOW_NETWORK=true` and the task's network setting. This repository does not automatically provision machines, clone arbitrary repositories, install project dependencies or provide shared multi-tenant hosting.

## Plugins and registries

Use **Plugins** in workspace settings to install, update or remove a reviewed folder. A package contains `hikari-plugin.json` with a name, semantic version and description, plus optional `skills`, `hooks`, `agents`, `lsp` and `mcp` entries. See `examples/plugin/hikari-plugin.json`. Skill entries point to directories containing `SKILL.md`; public names become `plugin:skill`. Roles and MCP names use a `plugin-` prefix. Paths in command arguments can use `${plugin}` for the installed package directory.

```sh
pnpm agent plugin inspect examples/plugin
pnpm agent plugin install examples/plugin
pnpm agent plugin list
pnpm agent plugin update /path/to/new-version
pnpm agent plugin remove project-review
```

Installation does not run package scripts. Imports reject symbolic links and special files and are bounded to 200 files, 2 MB per file and 20 MB total. The installed content has a SHA-256 lock; modifying it requires reinstalling. Update and removal wait until active project tasks end in the desktop. CLI operators must also stop project tasks before changing extensions.

A registry is a local file or HTTPS JSON catalogue with `plugins` entries containing `name`, `version`, `description`, `path` and `sha256`. Relative paths resolve from the catalogue. `pnpm agent plugin registry registry.json` discovers entries without installing them. Pass the selected path and SHA-256 to `plugin install PATH SHA256` to verify the package. Registries can be distributed through your existing repository or file service; an online marketplace and automatic updates are not hosted by Hikari.

### Distributing plugin bundles

Run `pnpm agent plugin pack examples/plugin /tmp/project-review.bundle.json` to produce a bundle and its content hash. Host the bundle and a registry JSON on your HTTPS file service. Registry paths may be relative URLs. The desktop can browse a registry URL and install or update a selected version with its displayed SHA-256. Remote installs require a pinned hash, verify the package name and version, reject path traversal and do not follow redirects. CLI use: `plugin registry https://example.com/registry.json`, then `plugin install https://example.com/project-review.bundle.json SHA256`.

## GitHub and CI

`integrations/github-action/action.yml` is a composite action for bounded read-only review. Supply the model ID, endpoint and model secret; the JSON report path is an output. Comment publication is opt-in through `post-comment: 'true'` and a suitably scoped `github-token`. Keep model credentials in repository or environment secrets. Use an appropriate checkout/base diff for the code you want reviewed, and do not expose secrets to untrusted fork workflows.

For service-side event triggers, set `HIKARI_GITHUB_WEBHOOK_SECRET` and `HIKARI_GITHUB_ROUTES` on the API server. Each route contains `repository`, account `owner`, `workerId`, `project`, `allowedActors` and optional `postResults`. Point GitHub's JSON webhook at `/integrations/github/webhook` with the matching secret. Supported triggers are opened/reopened Issues and opened/reopened/synchronized pull requests. Unlisted actors and repositories are rejected. Delivery IDs deduplicate jobs, including retries interrupted between persistence steps.

The worker retrieves the PR diff or Issue through GitHub's API and runs a read-only review. It does not check out or execute untrusted PR code. Set `GITHUB_TOKEN` on the worker for private repositories. Setting a route's `postResults: true` explicitly enables publishing/updating a result comment with that token. Model judgments and fixture tests do not establish that findings are correct; review the cited code.

## Conversation and code history

Under **Manage task → Conversation and code history**, choose a checkpoint, preview it, then restore the conversation, code, or both. Conversation restoration creates an interrupted task that can be resumed after inspection. It does not reactivate earlier approvals or trust old test results. Code-only restoration keeps the conversation.

The CLI equivalents are `pnpm agent timeline list`, `timeline preview ID` and `timeline restore ID code|conversation|both`. A conversation restore prints the new task ID for `pnpm agent resume ID`.

Snapshots are recorded before and after real workspace runs and retain at most 100 indexed entries. Text capture is bounded to 8 MB; binary/large files and file-mode changes require external restoration. A single code restore supports at most 20 text files. Files modified after the most recent recorded state cause a conflict instead of being overwritten. Other user files are retained. Private metadata, ignored dependencies and external side effects are not rewound. If capture fails, a `timeline.error` event explains why that point is unavailable. This complements Git; it does not replace commits or backups.

## Persistent goals

In **Task options → Acceptance and budgets**, enter a persistent goal, continuation limit and resource budgets. The CLI uses `AGENT_GOAL` and optional `AGENT_GOAL_CONTINUATIONS`.

```sh
AGENT_GOAL='Resolve the failing checkout tests and pass the acceptance suite' \
AGENT_MAX_TOKENS=100000 AGENT_MAX_MINUTES=30 \
pnpm agent run 'Investigate the checkout failure'
```

The goal stays in private checkpoints. Before reporting completion, the model must call `update_goal` with concrete evidence, and normal deterministic acceptance still applies. An unfinished answer continues toward the same objective within the original token, cost and time budgets. Pause/resume, cancellation, blockers, model-step limits and continuation limits still stop execution. Goal completion is a model report plus the configured checks, not a proof of arbitrary correctness. A blocked or exhausted goal remains unfinished; it is not silently marked complete.

## Execution ownership and reconnects

Desktop, CLI, workers, writable delegated agents and timeline restoration share workspace ownership records. One executor may hold a directory at a time; separate worktrees can run independently. Opening another host preserves history owned by a live process. Completion and setup failure release the claim. A later task can reclaim a dead process's claim, but never automatically replays its work.

Ownership lives in `.agent/state/execution-owner.json` and applies to a local filesystem on one machine. External editors, shared network drives and separate container PID namespaces are outside this protocol. All Hikari instances must support it. Short transactions use `.json.lock`; a crash during a transaction conservatively blocks later writes until an operator confirms no executor remains and removes the abandoned lock.

Workers retry temporary connection failures and HTTP 408, 429, 500, 502, 503 and 504 with backoff. Persistent claim IDs and idempotent update IDs handle responses lost after server processing without consuming a second job or repeating completion writes. Reconnects last at most 90 seconds and stop at least 5 seconds before the last confirmed 120-second lease expires. Credential and lease rejection stop immediately. The local job journal retains interruption details and the task ID; restarting a worker never replays a model task that already started.

## Verification boundaries

Use `pnpm check`, `pnpm build`, `pnpm docs:build`, the focused `platform-*.test.ts` tests and the desktop/browser suites when changing these capabilities. Tests use controlled model, LSP and GitHub fixtures and exercise actual local process/HTTP boundaries. They validate the harness and failure handling. Real-model quality, a particular installed language server, public webhook delivery, a deployed HTTPS server and actual GitHub publication require their respective live environments.

## Self-hosted quotas and operations

Defaults per account: 10 queued/running jobs and 5 workers. Jobs are capped at 200,000 tokens and 30 minutes. Configure `HIKARI_MAX_ACTIVE_JOBS`, `HIKARI_MAX_WORKERS`, `HIKARI_JOB_MAX_TOKENS`, `HIKARI_JOB_MAX_MS`. Missing job budgets receive server limits; larger requests are rejected. Versioned persistent reservations coordinate concurrent creators; failed creations can reserve capacity for up to 60 seconds. Completed jobs release execution capacity, not historical storage.

`/ready` checks the database and configured Redis (503 on failure); `/health` remains liveness. Set a separate `HIKARI_OPS_TOKEN` of at least 32 characters for Bearer-authenticated `/operations/status` (disabled returns 404). It exposes status counts, cumulative response time and memory without task data. The production entrypoint enables structured logging without bodies, authentication headers or URL queries.

These foundations do not supply billing, enterprise SSO, hosted container scheduling, a complete audit platform or a capacity SLA. Validate dedicated worker environments, backups, alerts and recovery before public hosting.
