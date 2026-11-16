# Development and verification

## Start locally

Use Node 24 LTS and the pnpm version in the repository's `packageManager` field. From the root:

```sh
pnpm install
pnpm dev
```

`apps/desktop/scripts/dev.mjs` builds main, preload and renderer, serves the UI at `127.0.0.1:5173`, and starts Electron. Vite can update renderer code; restart the development process after changing main or preload. An already running Electron process does not acquire new main-process code from a renderer refresh.

Project tools require Git and ripgrep. Install Chromium before using browser tools from source:

```sh
pnpm exec playwright install chromium
```

Development shares the normal desktop data location by default. Set `HIKARI_DATA_DIR` for isolated runs to keep personal tasks and model profiles separate.

## Repository map

| Directory                                              | Responsibility                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `apps/desktop`                                         | Electron, preload, React UI, attachment parsing and desktop services |
| `apps/cli`, `apps/server`                              | CLI entry and optional sync server                                   |
| `packages/agent-core`, `packages/shared`               | Task, event, tool and cross-process contracts                        |
| `packages/agent-runtime`                               | Scheduling, context, memory, permissions, checkpoints and workflow   |
| `packages/model-provider`                              | Provider protocols and offline examples                              |
| `packages/tools`, `packages/git`, `packages/sandbox`   | Project tools, delivery and execution boundaries                     |
| `packages/database`, `packages/mcp`, `packages/skills` | Persistence and extension protocols                                  |
| `tests`, `tests/e2e`                                   | Unit, Electron and documentation browser tests                       |

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm --filter @hikari/desktop build
pnpm docs:build
pnpm exec playwright test
```

Electron E2E needs a graphical session; use Xvfb on headless Linux. Documentation tests require built docs and a matching Playwright Chromium installation. For docs-only changes, run `pnpm docs:build` and `pnpm exec playwright test tests/e2e/docs.spec.ts`.

Electron tests use temporary data and controlled model responses. They verify approvals, real tools, recovery and UI integration, not live-model task success rates. `pnpm eval:agent --validate` validates fixed graders; use the credentials and evaluation commands in the [CLI guide](cli.md) for a real-model evaluation.

## TypeScript contracts

`pnpm typecheck` uses the installed TypeScript version, strict checking and `noUncheckedIndexedAccess`. `isolatedModules` and `verbatimModuleSyntax` check compatibility with the single-file esbuild/Vite pipeline and require explicit type-only imports. Incremental state stays in the ignored `.cache/typecheck.tsbuildinfo`; use `pnpm exec tsc --noEmit --incremental false` for a cold check.

`tests/types/desktop-ipc.ts` contains compile-only assertions checked by `pnpm typecheck`, including expected failures for invalid channels, return types and unvalidated input assumptions. Vitest runs runtime tests separately. Model discovery validates remote JSON before reading model fields and reports malformed replies as `MODEL_DISCOVERY` without including the response body.

## Native checks

DOM clicks do not cover native window hit testing or system input. After changes to title bars, dialogs, terminals or scaling, also use a real mouse and keyboard. Check × on a tall dialog near the top of the window, Escape and focus restoration, initially collapsed folders and one-level expansion, and terminal Chinese input/output and restart.

Relevant regressions include `desktop-ipc.test.ts`, `data-path.test.ts`, `persistence-batching.test.ts`, `context-budget.test.ts`, and E2E files `desktop.spec.ts`, `interaction-consistency.spec.ts`, `terminal.spec.ts` and `workspace-context.spec.ts`.

## Build and package

```sh
pnpm desktop:pack
pnpm test:package
pnpm desktop:dist
```

`desktop:pack` creates an application directory; `desktop:dist` creates installers in `.artifacts/releases/desktop/`. Both build code, check native modules and stage runtime dependencies and OCR assets without publishing. esbuild emits CommonJS for main and the attachment Worker, preload is built separately, and Vite builds renderer.

`test:package` launches the packaged application with an isolated temporary data directory and checks native modules, offline OCR, the bundled browser, terminal and sandbox execution. Verification and release CI both run this check; on Linux use `xvfb-run -a pnpm test:package`. It does not verify production signing, notarization or external model quality.

Build and verify on the target OS and architecture. See `apps/desktop/electron-builder.yml`. Check native modules, OCR data, browser resources and signing separately. The current macOS configuration uses local ad-hoc signing and does not establish notarization. Automatic updates require a release feed.

## Documentation and deployment

English pages live in `docs`, with matching pages in `docs/zh` and `docs/ja`. Update all three and the navigation in `docs/.vitepress/config.ts` when adding routes.

```sh
pnpm docs:dev --port 5174
DOCS_BASE_PATH=/hikari-agent/ pnpm docs:build
DOCS_BASE_PATH=/hikari-agent/ pnpm docs:preview --port 5174
```

The Pages workflow reads the deployment base. Local subpath checks must use the same `DOCS_BASE_PATH` for build, preview and docs E2E. Publishing docs is separate from releasing a desktop installer.

## Platform regression coverage

`platform-runtime.test.ts` covers goals, hooks, delegation and durable schedules; `platform-tools.test.ts` covers pinned plugin bundles, LSP transport and guarded history restoration. `platform-control.test.ts`, `platform-worker.test.ts` and `github-integration.test.ts` exercise account/lease boundaries, a separate worker process and opt-in result publication with fixtures. `vscode-integration.test.ts` validates editor context and secret storage against an extension-host API fixture.

`tests/e2e/platform.spec.ts` exercises actual Electron settings and a mobile browser controlling a live local host. To use an installed Chrome instead of downloading Playwright Chromium, run `HIKARI_TEST_BROWSER_CHANNEL=chrome pnpm test:e2e`. This is a test setting; production browser defaults stay unchanged. These checks do not establish real-model quality, live IDE-host acceptance, production deployment or GitHub acceptance.

`workspace-ownership.test.ts` starts a separate process and simulates a crash, checking cross-host exclusion, history protection and setup-failure cleanup. Worker integration tests discard claim, heartbeat and completion responses after server processing to verify reconnects and idempotency. `worker-transport.test.ts` covers cancellation, deadlines and non-retryable credential/lease rejection. `repository-eval.test.ts` checks pinned clones, failing baselines, independent grading and rejection of modified acceptance files. See [CLI](./cli#evaluating-pinned-local-repositories) for project evaluations.

## Release and model-quality gates

`scripts/release-desktop.mjs` already handles signed releases, separately from local ad-hoc packages. `node scripts/release-desktop.mjs --check` validates repository, version and platform credentials without building/uploading. Release CI now runs format, unit and desktop/docs E2E checks before publication. Certificates, notarization and actual platform acceptance remain external prerequisites.

Run `pnpm eval:report REPORT.json [REPORT.json ...]` against real-model reports. Defaults: 5 distinct cases, 3 samples each, 90% overall and per-case success, P95 at most 180 seconds. Configure `EVAL_MIN_CASES`, `EVAL_MIN_SAMPLES`, `EVAL_MIN_SUCCESS_RATE`, `EVAL_MAX_P95_MS`. Only one provider/model/workflow and `model-run` evidence are accepted; baseline/demo and duplicate files cannot supply samples. Report metadata alone does not prove an API call. No configured model means gate logic can be tested, not a model success rate.

For release, maintainers must still select licensing, review dependency notices, privacy, paid support and service terms. Prefer a limited local BYOK pilot before public hosted execution. No SLA or arbitrary task correctness is implied.

## Runtime composition and concurrency

`packages/agent-host/src/execution.ts` shares capability assembly, file acceptance and Runner cleanup across desktop, CLI and workers. Desktop conversation/attachment handling and scheduling remain adapters. `ResourceScope` rolls registrations and resources back in reverse order, including after setup failure; every closer is attempted.

A tool may opt into `parallelSafe` only for independent filesystem inspection. The Runner admits permissions in call order and overlaps at most three adjacent opted-in reads, then commits observations in original order. Writes, commands, unknown tools and tool hooks with possible side effects remain sequential. Interruptions wait for active reads to settle; unfinished calls retain their existing checkpoint recovery semantics.

Presentation updates share a 100 ms persistence buffer, capped at 2,000 pending events per task. Tool boundaries, checkpoints, reads and shutdown flush synchronously. A hard process loss can discard the unflushed presentation tail. Persistence subscriptions are critical: write failures stop execution, are checked before lifecycle side effects, and cannot be hidden by a later successful write. Presentation listener failures remain isolated.

Relevant regressions: `file-persistence-batching`, `resource-scope`, `execution-lifecycle`, `request-traces`, `parallel-reads`, `context-budget` and `agent-control`.

## Reproducible offline benchmarks

Run the existing dependencies without model requests or downloads:

```sh
node scripts/benchmarks/renderer.mjs 100 30
TSX_DISABLE_CACHE=1 node --import tsx scripts/benchmarks/runtime.ts
TSX_DISABLE_CACHE=1 node --import tsx scripts/benchmarks/runtime.ts --ref=a291620
```

The renderer benchmark instruments an in-memory production profiling bundle of the real UI, using fictional tasks and intercepted requests. It uses installed Chrome by default; `HIKARI_TEST_BROWSER_CHANNEL` selects another installed channel. Editor workers are unused in this scenario. It records App/Timeline renders, commits, p95 commit duration, store notifications and simulated list IPC count/bytes. Run identical task/frame counts on both revisions; repeat with 10, 100 and 1,000 tasks. This is browser renderer evidence, not native Electron IPC latency or live-model performance.

The runtime benchmark warms up five times, measures 30 trace appends and 10 skill queries, and prints p50/p95. `--ref` loads only the trace append implementation from that Git revision; skill discovery always uses the working tree. Compare metadata discovery, compatibility `list()` and selected-body loading using 100 fictional 60 KB skills. Trace sizes are 20,000 and 400,000 characters with 16 retained records. It excludes persistence I/O.

A local macOS arm64 sample (Node 24.14.1, Chrome 156): with 100 tasks and 2,000 history events, 240 background deltas caused App/Timeline renders and commits to change from 30 each to zero. A synchronous 240-state-event burst changed list calls from 240 to one (78,229,920 to 325,958 simulated snapshot bytes). Foreground delta commit p95 was 4.2 ms before and 4.4 ms after; no foreground latency improvement is claimed. At 6.4 MB retained traces, append p95 was 14.66 ms before and 14.93 ms after; one redundant encoding was removed, but this sample does not establish a speed gain. Keep OS, browser, runtime, input, budgets and warmup fixed when comparing. Unit/fixture checks, real-model runs and remote three-OS CI are separate evidence.

## Superagent verification

`pnpm exec vitest run tests/runtime/superagent.test.ts tests/integration/superagent-host.test.ts` checks admission, rule observation, mandate revalidation, subscriptions, unread-input preservation, structured handoffs, directory reuse and recovery. `pnpm exec playwright test tests/e2e/superagent.spec.ts` verifies the real supervision page with a local scripted provider. Tests open loopback fixture servers and use temporary projects; they do not contact paid models or publish results. See [design and limits](superagent.md).

## Shared application execution

All real desktop, CLI and worker requests now use `prepareAgentSession`, including work authorization, intent, layered memory and current project-source retrieval. The desktop supplies native interaction/storage adapters. See [the capability audit](architecture-upgrade.md), [packaging](packaging.md) and [API verification](provider-api-audit.md).

See [Agent reliability, evaluation and delivery](agent-readiness.md) for crash-safe transaction locks, recovery adapters, memory approvals, task benchmarks and accounting boundaries.
