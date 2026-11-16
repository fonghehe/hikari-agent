<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->


# Repository boundaries

- Start with `docs/architecture-upgrade.md` for the current directory map and capability boundaries. Keep all three documentation locales aligned when changing user-facing workflows.
- Applications compose adapters; `packages/agent-host` owns production session composition; `agent-runtime` separates runner, context, knowledge, persistence and orchestration. Public `index.ts` files contain exports, not implementations. Use direct implementation imports within a package and declared `@hikari/*` exports across packages.
- Desktop renderer features live under `features/`, common UI under `shared/`, composition under `app/`. Privileged APIs go through typed preload contracts. Preserve stylesheet import order in `shared/styles/index.css`.
- Group unit tests by domain in `tests/`; keep shared fixtures and E2E separate. Declare direct test dependencies at the root; do not import a sibling package's `node_modules`.
- Run `pnpm check`, `pnpm format:check`, builds and relevant E2E/package checks after structural changes. `pnpm typecheck` checks browser, main, Node and tooling environments separately. Do not substitute fixture results for live model or signed release evidence.
- Generated reports, package staging and releases go under `.artifacts/`; application `dist` and tool-owned caches stay at their conventional paths. Cleanup commands preview by default and require `--apply`. Preserve releases, `.agent` data, shared instructions, skill adapter links and local historical notes.
