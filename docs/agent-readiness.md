# Agent reliability, evaluation and delivery

The shared production composition root is `prepareAgentSession`. Desktop, CLI, workers and evaluations use this composition. Fixture results do not establish real-model success rates.

## Recovery and security

State JSON retains atomic replacement; per-key `.json.lock.sqlite` SQLite OS locks serialize transactions and release on abrupt process exit. Legacy ownerless `.json.lock` files require inspection. Local filesystems only; power-loss durability and network filesystems are not guaranteed.

Checkpoints retain operation outcomes and canonical parameter fingerprints. Trusted adapters may inspect outcomes without repeating actions; `write_file` compares current contents and original hash preconditions. `operation_status` and `reconcile_operation` expose bounded recovery. Reconciliation requires permission. Already-applied side effects cannot repeat; unknown outcomes remain blocked. Without a trusted adapter, human inspection remains necessary. Remote MCP descriptions cannot grant recovery trust. The 2,000-record journal does not guarantee exactly-once execution across semantically equivalent but different inputs.

Saved memory mutations use `memory.write`, independently of file writes, and retain task provenance. Deterministic attack-chain fixtures feed malicious web/MCP-like observations and poisoned memory through the production host, then attempt permission promotion, workspace escape and unauthorized connections. They test runtime enforcement, not universal model resistance to prompt injection.

## Task evaluation

`pnpm eval:agent --list` lists 24 controlled cases: six each for bug fixes, API-preserving refactors, project questions and frozen-source research. `--validate` checks broken baselines and reference results without running a model. Actual evaluations use `SessionHost`; capability probes use the same production composition and permission policy. Independent graders remain outside the agent-writable workspace and are not supplied as model acceptance commands.

Read-only questions/research check structured factual answers and current source evidence. They do not establish open-ended semantic quality or live-web research quality. Add representative pinned real repositories through `eval:repository`.

`eval:report` retains success/P95 gates and adds `EVAL_REQUIRED_CATEGORIES` (default `bugfix,refactor,qa,research`), `EVAL_MIN_CATEGORY_CASES` (1) and `EVAL_MAX_INVALID_RATE` (0.1). Both valid-run and end-to-end success are reported. Optional `EVAL_MAX_MODEL_COST_PER_SUCCESS_USD` and `EVAL_MAX_MEAN_INTERVENTIONS` fail when evidence is missing; missing metrics are not zero. Adjust category coverage explicitly for specialized reports.

## Delivery and accounting

`Task.delivery` records artifacts, acceptance evidence, unfinished items, limits and human handoff. Current files and final answers have content hashes; files are bounded to 64 records and 2 MB each. Proposed URLs remain unverified, unreadable/deleted files unavailable. A hash does not establish correctness. Empty checks are unverified; read-only Plan/chat may be outside execution acceptance. Final answer formatting is unchanged.

Summaries count questions, approval requests, denials and interventions, and separate active time from waiting/pauses. Overlapping waits are unioned; restored questions are not counted twice; application downtime is excluded. Runtime task deadlines still include waiting.

Cache prices use `cachedInputPerMillion` / `cacheWriteInputPerMillion`; evaluation environment variables are `AGENT_CACHED_INPUT_PRICE` / `AGENT_CACHE_WRITE_PRICE`. Missing cache prices fall back to input pricing with partial coverage. Proactive assessment calls have persistent token/cost/unknown-billing records and per-ticket aggregation. `assessmentBudget.maxCalls` defaults to 1,000 cumulative calls; optional `maxCostUsd` needs configured pricing and blocks after unknown billing. Detail retention does not reset cumulative counters.

External tool, embedding/reranking, infrastructure and unknown provider-retry charges are not fully metered. Displayed model costs use configured prices and are not invoices or complete task costs. No paid model evaluation was run as part of this engineering validation.

Code graders also import candidate code inside a restricted, network-disabled subprocess. This protects host files during verification; it is not a formal guarantee against all grader manipulation.
