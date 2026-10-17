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
pnpm --filter @hikari/desktop exec playwright install chromium
pnpm desktop:pack
pnpm test:package
pnpm desktop:dist
```

`desktop:pack` creates an application directory; `desktop:dist` creates installers in `apps/desktop/release/`. Both build code, check native modules and prepare browser resources without publishing. esbuild emits CommonJS for main and the attachment Worker, preload is built separately, and Vite builds renderer.

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
