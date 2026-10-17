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

Repository search and document RAG are separate. `RepositoryIndexer`, ripgrep and `search_code` discover files, match text and rank relevant paths. Hikari does not automatically embed the entire repository.

Attachment chunks and saved memory use `packages/agent-runtime/src/retrieval.ts`:

1. Normalized term matching works without an embedding endpoint.
2. With embeddings enabled, missing document vectors are computed in batches of 32. SHA-256 cache keys include endpoint, model and text, so changed content invalidates old vectors.
3. A query vector is compared by cosine similarity. Semantic candidates must exceed 0.15.
4. Reciprocal rank fusion combines lexical and semantic ranks and returns top results with source metadata. `search_memory` defaults to 8 entries and accepts 1–20.

LangChain supplies Retriever, Document and OpenAI Embeddings interfaces; ranking is implemented in project code. This is not BM25, an ANN index or a reranker pipeline. Initial memory selection uses the separate keyword scorer in `memory.ts`, which favors title matches.

## Efficiency and accuracy

Semantic collections are capped at 2,000 chunks and 3 million characters. Each scope caches at most 2,000 vectors. Caching avoids repeated document embedding, but similarity still scans candidates linearly and each query is embedded again. Larger knowledge bases need measured indexing and retrieval evaluation.

There is no fixed accuracy guarantee. Use representative questions and labeled sources to measure Recall@k, MRR and source hit rate, alongside cold/warm latency and embedding request counts. Verify retrieved claims with files and tools. Reduce irrelevant chunks, preserve sources and retire stale facts before simply raising result limits.

Semantic search sends the query and candidate document or memory text to the configured embedding endpoint, subject to network approval. Its cost is separate from the chat budget. Keyword retrieval remains available when embeddings are disabled. Endpoint failures and dimension changes produce errors rather than pretending semantic retrieval succeeded. See [Model settings](configuration.md).

## Backup, restore and diagnostics

Open **Settings → Data & updates → Data and diagnostics**. Backups use SQLite backup, including committed WAL data. They contain private tasks, attachments, memory and encrypted credentials; the backup itself is not fully encrypted. Project files and worktrees require separate Git/file backups.

Restore validates integrity, tables and schema version, then applies on the next startup after saving `before-restore-*.sqlite`. New tasks are blocked until restart or cancellation. Close external database clients first. Newer schemas are rejected; credentials may require reconnecting on another machine.

Cleanup only removes archived terminal tasks older than 30 days without worktrees, after confirmation and a `before-cleanup-*.sqlite` backup. Unreferenced attachments, events, checkpoints and tool outputs are deleted. Shared project memory/vectors remain. Manage private safety backups separately. Diagnostic export includes versions, counts, database size and resource usage, without prompts, content, project paths or credentials.

## Sensitive data policy

Direct agent access, discovery and code history exclude credential paths such as `.env`, private keys, `.aws` and `.ssh`. Configuration examples/templates remain readable. Configure secrets manually or supply redacted excerpts. History cannot restore excluded files.

Common credential patterns and private-key blocks are redacted from contexts, saved tool output, embedding requests and provider replay fields. Live command output buffers complete lines. This is best-effort text protection: arbitrary encodings, split secrets and image pixels are not covered. Approved host commands, networked processes and MCP services have independent effects. Native masking covers discovered sensitive paths including dependency/build directories, and rejects scans exceeding one million directory entries. Hard links, newly created files and arbitrary encodings still need additional controls.

On Linux, unknown/unavailable stores and `basic_text` do not persist model or MCP secrets. A known `basic_text` backend clears legacy model/profile/MCP credential records. Unknown or temporarily locked stores preserve protected records; new secrets remain in memory. This is not forensic erasure; manage older private backups separately.

Search matches sanitized text, limited to 512 KB per file and 64 MB per call; narrow the glob when exceeded. Read offsets refer to sanitized text while SHA-256 covers original bytes. Whole-file writes containing redaction placeholders are refused when the original has secrets; use focused patches. Sensitive Git diff contents are omitted from agent output for manual review.
