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

`pnpm eval:agent` runs real model tasks with independent behavioral checks in temporary workspaces. It requires your real model configuration and uses tokens. `EVAL_SAMPLES=1..10` controls attempts per task. Results show success rate, actual checks, duration and reported/estimated usage under `.agent/evals/`. No demo/provider fixture is accepted as a real evaluation.

## Model presets and development workflow

Set `AGENT_PROVIDER` to a provider ID from [Model configuration](configuration.md), such as `deepseek`, `qwen`, `kimi`, `glm`, `gemini`, `doubao`, `minimax`, `siliconflow`, `groq`, `grok`, `mistral`, `openrouter`, `ollama` or `lmstudio`. A preset supplies its default endpoint; `AGENT_BASE_URL` overrides it for regional or private services. Azure and `compatible` require an explicit endpoint.

`AGENT_WORKFLOW=development` selects investigation, planning, implementation and independent read-only review. `AGENT_CONTEXT_WINDOW` and `AGENT_MAX_OUTPUT_TOKENS` set model limits; `AGENT_STREAMING=false` uses non-streaming replies. `AGENT_REASONING_EFFORT=low|medium|high` requests a supported reasoning level. Resume with the original provider, model and endpoint.

Evaluations cover numeric correctness, stable deduplication, changes across modules, cancellation and untrusted repository content. `pnpm eval:agent --validate` checks that the fixed graders reject broken fixtures and accept reference solutions without contacting a model; it does not measure agent quality. Real evaluations record success, latency percentiles, tool failures, verification and token/cost usage. Compare standard and development workflows using the same model and sample count.
