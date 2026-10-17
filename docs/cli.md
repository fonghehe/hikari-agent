# Command-line usage

Use the CLI from a Hikari source checkout after [installing its dependencies](installation.md#run-from-source).

## Offline questions

Without model configuration, the CLI uses offline demo. You can also select it explicitly:

```sh
AGENT_PROVIDER=demo pnpm agent run "Hello"
AGENT_PROVIDER=demo AGENT_MODE=plan pnpm agent run "Analyze the sample architecture"
```

Demo output is a predefined example, not a real project edit or test run.

## Use a real model

Set the values for your own provider and workspace, then run a request:

```sh
export AGENT_MODEL='your-model-id'
export AGENT_API_KEY='your-key'
export AGENT_BASE_URL='https://your-provider.example/v1'
export AGENT_WORKSPACE='/absolute/path/to/repository'
pnpm agent run "Find the failing test and fix it"
```

For Anthropic, also set `AGENT_PROVIDER=anthropic` and use its API address. For a local compatible service, use its supplied address; a key is optional when that service permits it.

## Options and controls

| Setting               | Use                                                  |
| --------------------- | ---------------------------------------------------- |
| `AGENT_PROVIDER=demo` | Choose offline demo.                                 |
| `AGENT_MODE=plan`     | Analyze without changing files or running commands.  |
| `AGENT_MODE=execute`  | Run an implementation task; the default mode.        |
| `AGENT_MAX_STEPS=30`  | Set the model-turn limit, from 1 to 100.             |
| `AGENT_VISION=true`   | Allow screenshot input for a model that supports it. |

The CLI prints task events. An interactive terminal prompts before operations requiring approval; non-interactive input denies those operations. Press **Ctrl+C** to interrupt and save a real run, or cancel an offline demo.

## Resume and budgets

A real run prints its task ID. Press Ctrl+C to interrupt and save its state, then run `pnpm agent resume TASK_ID` in the same workspace with a real model configured. A pending question needs an interactive terminal. Completed/cancelled runs cannot be resumed.

Use `AGENT_MAX_TOKENS`, `AGENT_MAX_COST_USD`, `AGENT_MAX_MINUTES`, `AGENT_INPUT_PRICE` and `AGENT_OUTPUT_PRICE` to set budgets and prices per million tokens. `AGENT_EXECUTION=restricted` is the default; `AGENT_EXECUTION=host` explicitly permits approved host commands. `AGENT_NETWORK=true` permits network inside the sandbox.

## Model presets and development workflow

Set `AGENT_PROVIDER` to a provider ID from [Model configuration](configuration.md), such as `deepseek`, `qwen`, `kimi`, `glm`, `gemini`, `doubao`, `minimax`, `siliconflow`, `groq`, `grok`, `mistral`, `openrouter`, `ollama` or `lmstudio`. A preset supplies its default endpoint; `AGENT_BASE_URL` overrides it for regional or private services. Azure and `compatible` require an explicit endpoint.

`AGENT_WORKFLOW=development` selects investigation, planning, implementation and independent read-only review. `AGENT_CONTEXT_WINDOW` and `AGENT_MAX_OUTPUT_TOKENS` set model limits; `AGENT_STREAMING=false` uses non-streaming replies. `AGENT_REASONING_EFFORT=low|medium|high` requests a supported reasoning level. Resume with the original provider, model and endpoint.

## Run evaluations

Both evaluation commands load the repository-root `.env`; exported variables take precedence. They do not inherit saved desktop model profiles. Run `cp .env.example .env`, then enter your provider, model ID and key. Leave `AGENT_BASE_URL` blank for a provider preset; compatible and Azure providers require an explicit URL. Local key requirements depend on the service.

Help and case listing need no credentials and make no model requests:

```sh
pnpm eval:agent --help
pnpm eval:agent --list
pnpm eval:capabilities --help
pnpm eval:capabilities --list
```

Start with a selected case before running the full suites:

```sh
EVAL_CASES=cart-rounding EVAL_SAMPLES=1 pnpm eval:agent
CAPABILITY_CASES=plan-is-read-only pnpm eval:capabilities
# All cases: pnpm eval:agent / pnpm eval:capabilities
```

Real runs use model tokens and automatically approve evaluation tools in temporary workspaces. Browser probes need an installed Chromium. The four capability cases cover read-only plans, stream cancellation, recovery without duplicate side effects, and browser observation/interaction. `cancel-live-model-stream` requires streaming; exclude it with `CAPABILITY_CASES` for a service without streaming support.

Both commands honor `AGENT_MAX_TOKENS`, `AGENT_CONTEXT_WINDOW`, `AGENT_MAX_OUTPUT_TOKENS`, `AGENT_STREAMING` and configured token prices. Missing or invalid settings produce an actionable error rather than an empty successful report. Exit codes are 2 for configuration errors, 1 for failed evaluations and 0 for success. Each case prints progress; full reports live under `.agent/evals/`.

Without a model, `pnpm eval:agent --validate` checks six fixed graders. It establishes only that broken fixtures fail and reference solutions pass, not agent quality. Capability probes have no offline validation mode. Passing a case does not replace verification in a real project.

Agent cases cover currency arithmetic, stable deduplication, cross-file changes, cancellation, untrusted repository content and test-driven repair. The repair case must reproduce a failing test before editing and preserve its tests. Reports include success rate, latency percentiles, tool failures, verification, usage and private task events. `EVAL_SAMPLES=1..10` controls attempts per case; keep failed runs and use the same model and samples when comparing workflows. The default is 100,000 tokens per task.

Install browser dependencies with `pnpm exec playwright install chromium` before the browser case.

## Automation and integrations

Run `pnpm agent platform-help` for schedules, plugins, history, remote control, workers and CI. See the [platform guide](platform.md) for configuration, approvals and deployment.

## Evaluating pinned local repositories

Create a local suite from `examples/evals/repository-suite.json`. Each case specifies a local repository, a full commit SHA, a prompt, a fixed grading command, allowed edit paths and tests or configuration that must remain unchanged. Replace both the placeholder path and the all-zero commit.

```sh
EVAL_REPOSITORY_SUITE=/absolute/path/to/suite.json pnpm eval:repository --validate
EVAL_REPOSITORY_SUITE=/absolute/path/to/suite.json EVAL_SAMPLES=3 pnpm eval:repository
```

Relative repository paths resolve from the suite file. Each sample clones the pinned commit into a temporary directory, excluding uncommitted source changes and leaving the source checkout untouched. `setup` accepts up to five preparation commands. Setup is offline by default; explicitly set `setupNetwork: true` for a case that downloads dependencies. Review these commands and the grader yourself. Agent execution and final grading remain offline.

`--validate` checks checkout, preparation and a failing baseline without a model; it does not validate repair quality. Actual runs use `AGENT_*`, `EVAL_CASES` and `EVAL_SAMPLES`, with at most 50 steps, three minutes and the configured token budget per task. Success requires a completed task, nonempty Git-visible edits confined to allowed paths, unchanged preserved files and a passing independent grader. Modifying tests cannot turn a passing command into an accepted result.

Reports, redacted task records and patches appear under `.agent/evals/*-repository/`. Reports include commit IDs, baseline and final exit codes, usage, duration and file-boundary checks. Missing model configuration fails explicitly. Controlled-model integration tests do not establish real-model success rates.

Path checks cover tracked files and non-ignored new files, excluding private `.agent` data. They do not integrity-scan dependencies or other ignored files. Explicitly include acceptance tests and configuration in `preservePaths`, and review the resulting patch.
