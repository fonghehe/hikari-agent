# Run, verify and resume

## Define completion

Open **Acceptance and budgets** under the task input. Add a **file check** (path, expected existence, optional required text) or a **test command** (executable, one argument per line, working directory). Use commands you trust: acceptance tests still require permission.

The agent cannot mark an Execute task complete while a configured check fails. File changes require a passing test after the last change by default. Select **Use acceptance checks only** for tasks where tests do not apply, such as document edits. A Plan describes proposed work and does not execute acceptance commands.

Check the **Acceptance passed/failed** result and actual check attempts. Passing these conditions does not establish correctness beyond what they check.

## Give input during a run

Type additional instructions and send while a task runs. They apply at the next safe model step; a tool already running may finish first. Attachments can be sent after the current turn finishes.

If the agent asks a question, choose an offered answer or type your own. Execution waits for your answer. Cancel remains available while waiting.

## Resume after closing the app

Unfinished real tasks with valid saved state appear as **Interrupted**. Connect a real model, select the task and click **Resume**. The original task, conversation, tool observations, plan, pending question and budgets continue. Completed tool actions are not replayed automatically.

When an operation stopped before its outcome was recorded, Hikari asks whether to inspect and continue. Check files or the external service before repeating that operation: it may already have taken effect. A missing or invalid saved state requires Retry instead. Cancellation does not undo changes.

## Limit usage

Set a token, USD or time limit before sending. Leave a field empty for no additional limit. Limits carry over when resuming; Resume does not reset the budget. Time limits include waiting for input and permissions.

For USD budgets, enter your provider's input/output prices in **Model settings → Usage and compatibility**. Costs use those configured prices; they are not an invoice. Usage returned by the API is labelled **provider reported**; missing usage is labelled **estimated**. Unsupported output-limit parameters or streaming usage can be adjusted for compatible services. **Test connection** uses a small model request and checks whether a tool call is returned.

## Choose command access

**OS sandbox** is the default for agent commands and stdio MCP processes. It permits workspace changes and denies access to private files outside the allowed workspace/runtime paths. Network is disabled unless **Allow network in sandbox** is enabled. Browser and HTTP MCP access still need approval.

macOS uses its native sandbox. Linux needs bubblewrap. On Windows, install Docker Desktop and build the command image once from the checkout: `docker build -t hikari-sandbox:local -f containers/sandbox.Dockerfile .`. Commands run inside the Linux container; install additional toolchains in a derived image using the same tag. An unavailable sandbox produces an error and never silently switches to host access.

Choose **Host access** only when the task needs a toolchain the sandbox cannot provide. Approved host commands have your account's access. The interactive Terminal also runs directly on the computer.

## Memory, web and updates

Ask the agent to remember a useful project fact or decision. Open **Memory & extensions** to review and forget entries. Project memories are local reference data; they do not override your request.

Web pages can be read in a normal conversation with approval. To search, configure the URL of your SearXNG `/search` service with JSON results enabled in Model settings. Search questions go to that service; source pages are read through the browser. Missing or failed services are reported rather than replaced with invented search results.

**Memory & extensions → Application updates** offers Check, Download and Restart separately. Updates require a packaged release with an update feed. Finish active tasks before installing. Local builds without a feed display that limitation.

## Development workflow

In **Acceptance and budgets → Workflow**, select **Investigate → Plan → Implement → Review**. Investigation and planning inspect the project without writes or commands. The implementer receives their findings, edits through approved tools and must satisfy your acceptance checks. A separate, read-only reviewer then inspects the current result against your goal. Findings return to implementation for another verified attempt, with at most three review rework rounds.

The workflow, handoffs, conversation summary and pending question are saved with the task. **Resume** continues the same stage and budgets. The reviewer cannot use shell, writing, browser or external MCP tools. A review pass is model judgment; check the actual test evidence as well.

## Worktree delivery

Enable the worktree option for a new Execute task. In **Worktree starting point**, choose **HEAD** for committed files or **Include current uncommitted files** to copy tracked and untracked files that Git does not ignore. Source files stay in place. Dependencies and ignored files are not copied; request any required setup as an approved task command. A repository needs at least one commit.

After tasks using that worktree finish, open **Isolated worktree → Preview delivery**. Inspect the patch and conflicts, then **Apply to workspace**. Delivery rejects changes made to the source or worktree since the preview and preserves pre-existing edits. It supports at most 20 UTF-8 text files of 512 KB each. Use Git or an external editor for larger, binary, special-mode or conflicted changes. Re-run checks in the original workspace after delivery. **Undo delivered changes** refuses to overwrite later edits.

**Archive and clean up worktree** saves tracked and untracked files locally before removing the checkout. Ignored files are excluded. Cancel an interrupted task first. **Restore worktree** restores the saved files for inspection or a new follow-up; it does not resurrect old approvals or an unfinished run.

## Organize conversations

Open **Manage task** to rename, export, archive or delete a task. **Task history → Show archived tasks** displays archived conversations. **Import conversation** opens an exported Hikari JSON file; **Continue locally** imports a downloaded sync snapshot into a new local conversation. Select a local workspace first if you want project tools in the next turn.

Imports carry the prompt and previous answer as reference data. They do not restore attachments, checkpoints, approvals or prior verification. Attach needed files again and inspect the current workspace. Exports omit credentials, image content and private execution checkpoints. Deleting a task does not delete project files; archive its worktree first. The sidebar's **Recent workspaces** selector reopens a previously selected project.

## Review memory and permissions

In **Memory & extensions**, edit a saved memory's title, content, source or expiry date, or forget it. Expired entries remain visible for review but are excluded from retrieval. The agent can maintain a structured task summary containing goals, constraints, decisions, open items and evidence for long tasks.

**Persistent permissions** lists saved approvals. **Revoke** removes a saved approval and clears session grants. An already running operation may finish; new requests require approval again.
