# Data, memory and retrieval

## Local data

The default directory is `Hikari` under Electron's appData location. The database is named **`hakari.sqlite`**, matching the current implementation rather than `hikari.sqlite`.

| OS      | Default file                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Hikari/hakari.sqlite`                                                |
| Windows | `%APPDATA%\Hikari\hakari.sqlite`                                                                    |
| Linux   | Usually `~/.config/Hikari/hakari.sqlite`; Electron's appData setting determines the actual location |

Set `HIKARI_DATA_DIR` for a separate directory. `FORGE_DATA_DIR` is a legacy fallback. If the target database does not exist, startup searches legacy names, uses SQLite backup to include committed WAL data, checks integrity and publishes the new file while preserving the original. An existing target is never overwritten.

SQLite uses WAL. Use a consistent SQLite backup or quit Hikari before copying. Copying only the main file during execution can omit committed data still in WAL.

## Inspect with DataGrip

Create a **SQLite** data source and select the actual `hakari.sqlite` file. No host, port or application account is needed. Install the SQLite driver if DataGrip requests it. Prefer a read-only connection or a copy for inspection; do not edit live checkpoints, grants or version fields.

Every table has `id`, `owner`, `version`, `data` and `updated_at`. Desktop records use owner `local`; `data` contains JSON text. Example read-only queries:

```sql
SELECT id, version, updated_at, data
FROM tasks WHERE owner = 'local'
ORDER BY updated_at DESC LIMIT 20;

SELECT id, data FROM messages
WHERE owner = 'local'
  AND (id LIKE 'memory:%' OR id LIKE 'checkpoint:%');
```

| Record                                | Purpose                                             |
| ------------------------------------- | --------------------------------------------------- |
| `tasks`, `events`, `changes`          | Tasks, event history and change review              |
| `messages` / `checkpoint:<taskId>`    | Resumable execution state                           |
| `messages` / `memory:<scope>`         | Persistent project memory                           |
| `messages` / `vectors:<scope>`        | Retrieval vector cache                              |
| `tool_calls` / `output:<taskId>:<id>` | Paged large tool results                            |
| `model_configs`                       | Preferences, encrypted profiles and MCP credentials |
| `grants`, `workspaces`                | Persistent approvals and recent projects            |

Model keys and MCP tokens are encrypted when OS safe storage is available; otherwise they remain in process memory. Project content, tasks, memory and tool outputs are not encrypted as a whole database. Cached vectors are local records, not a separate vector database.

## Three kinds of memory

| Concept            | Implementation                                                                                                     | Persistence                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Short-term context | `ContextManager` holds model messages and tool exchanges; follow-ups load related history                          | Tasks retain history and checkpoints support recovery; context is compacted to fit budgets, so not all history reaches every model call |
| Working memory     | `MemoryManager` holds the original goal, plan, summary, decisions and open work; the runner tracks execution state | `RunnerCheckpoint` saves messages, working memory, budgets, pending questions and workflow stage                                        |
| Long-term memory   | `remember` / `search_memory` with project-scoped title, content, source and expiry                                 | `LocalPersistence.memories` stores SQLite records; isolated worktrees use the original project's scope                                  |

Persistent memory does not automatically contain every conversation. The agent saves useful facts through the approved `remember` tool. Review, edit and remove them in **Project chats → Memory & extensions**. Each scope allows at most 100 entries. New tasks first select relevant memories by keyword; expired entries remain visible but are excluded from retrieval.

Memories and model-written summaries are reference data. They can be stale or wrong and cannot override the user or replace file and test evidence. See [Run controls](run-controls.md) for checkpoint recovery.

## Retrieval paths

Repository search (`RepositoryIndexer`, ripgrep, `search_code`) remains separate and does not automatically embed the repository.

Desktop attachments and project memory now use persistent SQLite tables: `rag_chunks`, `rag_vectors`, `rag_search`, `rag_status`, `rag_source_tombstones`. CLI/worker memory uses `.agent/runs/knowledge.sqlite`. Old `messages/vectors:<scope>` records remain a compatibility cache. The index is private, excluded from conversation sync and included in desktop database backups. CLI indexes need a separate backup or rebuild.

- New attachments split along headings/paragraphs, targeting 1,800 UTF-16 characters with 180-character overlap. Bounded fenced blocks stay intact. These are character limits, not Token counts. Labels/headings are bounded; offsets refer to sanitized text (page-local for PDF). Older attachments keep their saved chunks.
- First search or explicit `index_attachments` / `index_memory` builds a snapshot. Embeddings are optional; missing document vectors are computed in batches of 32 and reused by endpoint, model, optional revision and content. Change revision when a provider changes a model under the same name.
- Publication is atomic and generation-checked. Failed/cancelled builds retain the old snapshot, but a changed-corpus search fails instead of returning the old corpus. Current sources are rechecked after provider calls. Source deletions invalidate indexed copies and in-flight publications. Interrupted builds retry on the next explicit index/search; upload does not automatically initiate background network processing.
- Persistent lexical retrieval uses FTS5/BM25 with normalized terms and CJK bigrams. The no-store compatibility route uses substring term scoring. Semantic retrieval performs exact cosine search with threshold 0.15. RRF (constant 60) fuses the rankings, with 40 candidates by default.
- Optional HTTP model reranking processes candidates before final top-k. Failures carry `rerank: fallback` / `RERANK_UNAVAILABLE`; cancellation still cancels. `score` is the fusion score and `rerankScore` is provider-specific, neither is calibrated confidence.
- Results have stable scope-bound `citationId` values. `read_attachment_source` / `read_memory_source` reject changed, deleted, expired or out-of-scope sources. `read_attachment` reads adjacent chunks by index. The default 24,000-character serialized output budget includes metadata and JSON escaping; truncation is marked.

`get_attachments_index_status` / `get_memory_index_status` report build state and active snapshots. Attachment search defaults to 6 results (1–12), memory to 8 (1–20). Initial memory selection still uses the separate title-weighted scoring in `memory.ts`.

## Efficiency and accuracy

Semantic collections remain bounded to 2,000 chunks / 3 million characters. Vector comparison is linear, queries are re-embedded each time, and this backend has no ANN index. Provider calls are asynchronous, but local SQLite reads/publication are synchronous. Larger workloads require measurements and a dedicated backend evaluation.

Embedding/reranking sends sanitized queries/reference text to configured endpoints under network permission; charges are separate from chat budgets. When enabled, the main search tools require network permission. Additional `search_attachments_local` / `search_memory_local` tools provide keyword-only access even in read-only workflow stages. Embedding failures are errors; reranker failures explicitly fall back.

`pnpm eval:retrieval` runs 20 synthetic multilingual keyword cases with Recall@3, MRR@3, no-answer accuracy and latency. This is not a live-model quality benchmark. Validate real-provider recall, ranking, citations, cold/warm latency and costs using representative documents and labelled sources.

## Backup, restore and diagnostics

Open **Settings → Data & updates → Data and diagnostics**. Backups use SQLite backup, including committed WAL data. They contain private tasks, attachments, memory and encrypted credentials; the backup itself is not fully encrypted. Project files and worktrees require separate Git/file backups.

Restore validates integrity, tables and schema version, then applies on the next startup after saving `before-restore-*.sqlite`. New tasks are blocked until restart or cancellation. Close external database clients first. Newer schemas are rejected; credentials may require reconnecting on another machine.

Cleanup only removes archived terminal tasks older than 30 days without worktrees, after confirmation and a `before-cleanup-*.sqlite` backup. Unreferenced attachments, events, checkpoints and tool outputs are deleted. Shared project memory/vectors remain. Manage private safety backups separately. Diagnostic export includes versions, counts, database size and resource usage, without prompts, content, project paths or credentials.

## Sensitive data policy

Direct agent access, discovery and code history exclude credential paths such as `.env`, private keys, `.aws` and `.ssh`. Configuration examples/templates remain readable. Configure secrets manually or supply redacted excerpts. History cannot restore excluded files.

Common credential patterns and private-key blocks are redacted from contexts, saved tool output, embedding requests and provider replay fields. Live command output buffers complete lines. This is best-effort text protection: arbitrary encodings, split secrets and image pixels are not covered. Approved host commands, networked processes and MCP services have independent effects. Native masking covers discovered sensitive paths including dependency/build directories, and rejects scans exceeding one million directory entries. Hard links, newly created files and arbitrary encodings still need additional controls.

On Linux, unknown/unavailable stores and `basic_text` do not persist model or MCP secrets. A known `basic_text` backend clears legacy model/profile/MCP credential records. Unknown or temporarily locked stores preserve protected records; new secrets remain in memory. This is not forensic erasure; manage older private backups separately.

Search matches sanitized text, limited to 512 KB per file and 64 MB per call; narrow the glob when exceeded. Read offsets refer to sanitized text while SHA-256 covers original bytes. Whole-file writes containing redaction placeholders are refused when the original has secrets; use focused patches. Sensitive Git diff contents are omitted from agent output for manual review.

## Private model request records

Before calling a model adapter, the runtime records its prepared provider-neutral messages, tool definitions, selected model identity, output limit, estimated input budget and compaction counters. These are private diagnostic inputs, not proof of an HTTP request, a provider wire-format transcript or successful model execution. The record does not include configured API keys; existing best-effort text redaction applies. Full local backups include these private records, while conversation exports and sync snapshots do not.

CLI/worker records use `.agent/runs/requests-<task-id>.json`; desktop records use the private `tool_calls` key `requests:<task-id>`. Each task retains at most 16 records and approximately 8 MB. An individually oversized request keeps metadata and a hash with `omitted: size-limit`, instead of duplicating its input or failing the task. Deleting desktop task outputs also deletes its request records.

Compaction preserves bounded observation heads/tails and saved-result references; it does not replace evidence with an invented semantic summary. Full recovery messages remain unchanged. The latest complete tool exchange and durable task summary keep their existing priority. Provider-reported cached input and cache-write tokens are recorded when available; unavailable values remain absent. Monetary estimates continue to use the configured input/output unit prices and do not infer cache discounts.

Expired memories remain available for review until capacity is needed. When inserting a new fact into a full 100-entry scope, Hikari removes expired entries in that scope before checking capacity again. Active facts and other project scopes are preserved. Medium tool logs that are compacted can also be archived as task-local paged results, retaining a reference and bounded diagnostic text without rerunning the original operation.

## Superagent records

The CLI service stores its policy versions, source events, admission decisions, tickets, input delivery/read markers, assignments, local notices and queued side-effect intents in `.agent/state/superagent.json`. It uses the existing atomic StateStore and a project ownership lease. Executor Tasks/checkpoints remain in `.agent/runs/`. The file is private source data with a 16 MB bound; see [recovery and storage limits](superagent.md#execution-and-recovery). This storage is independent of desktop SQLite task history.

## Shared application execution

All real desktop, CLI and worker requests now use `prepareAgentSession`, including work authorization, intent, layered memory and current project-source retrieval. The desktop supplies native interaction/storage adapters. See [the capability audit](architecture-upgrade.md), [packaging](packaging.md) and [API verification](provider-api-audit.md).

See [Agent reliability, evaluation and delivery](agent-readiness.md) for crash-safe transaction locks, recovery adapters, memory approvals, task benchmarks and accounting boundaries.
