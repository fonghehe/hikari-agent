# Tasks and workspace

## Start and find tasks

Click **New task** or press **⌘N / Ctrl+N** to start a fresh conversation. Enter a goal and send it with **Enter**; **Shift+Enter** inserts a new line. Cancelling the folder picker preserves your draft.

Choose **Tasks** to browse history. Search by task title or workspace and select a task to see its conversation and results. Your history remains available after restarting Hikari; interrupted tasks are not resumed automatically.

## Plan and execute

Choose the mode before sending a task:

| Mode        | Use it for                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| **Plan**    | Reading the project, explaining problems, and proposing steps without changing files or running commands. |
| **Execute** | Implementing changes and running approved tools.                                                          |

**Maximum model turns** limits the number of model turns in one run: 1–100, with 30 as the default. A run may stop when it reaches this limit or repeatedly encounters the same failure.

After reviewing a plan, click **Use plan in Execute**, edit the prepared prompt if needed, and send it. The button prepares the next run; it does not start execution by itself.

## Pause, cancel and continue

- **Pause** stops at the next safe boundary. A tool already running may finish before the task becomes paused.
- **Resume** continues a paused task or a recoverable interrupted task.
- **Cancel** stops the current run. Changes already made are not automatically undone; review them in **Diff**.
- **Retry** starts another run with the same request. Check the failure message and current files first.
- **Follow-up prompt** continues a finished, failed or cancelled task. Select **Next mode** for the new turn. **Previous turn** returns to the earlier conversation.

## Approve an operation

Read the tool name, arguments and target workspace before choosing **Allow once**, **Allow for session**, **Always allow**, or **Deny**. Only grant lasting permission when you trust the operation. Agent commands use the selected OS sandbox or host access. External connections require approval.

## Read files and review changes

**Files** shows a directory tree for the selected task. Expand folders, click a file to read it, or use **Expand all / Collapse all**. The file viewer is read-only.

Pause the task and wait for it to become paused, or let it finish, before reviewing **Diff**:

| Action     | Result                                                       |
| ---------- | ------------------------------------------------------------ |
| **Accept** | Marks a change as reviewed. It does not create a Git commit. |
| **Reject** | Restores the state before that change.                       |
| **Undo**   | Reverts a change, including one you accepted.                |

If a file has changed again, Hikari may refuse to overwrite it. Review the newer changes first; undo multiple changes to one file in reverse order. Demo review actions affect sample data only.

The result card records tool activity and test outcomes. An agent's answer is not proof that tests passed; check the actual recorded result.

## Use an isolated worktree

For an **Execute** task in a Git repository, enable **Isolate in a Git worktree** to keep task changes separate. The repository must have an initial commit. Choose the latest commit or include your current uncommitted files with **Worktree starting point**.

Follow-ups use the same worktree. Worktrees remain available after completion. Use **Preview delivery**, **Apply to workspace**, **Archive and clean up worktree**, and **Restore worktree** as described in [Run controls](run-controls.md#worktree-delivery).

## Terminal and browser

In **Terminal**, click **Open terminal** to start a shell in the selected task's folder, or in the current workspace if no task is selected. **Restart terminal** opens a new session after exit. Commands you type here run directly on your computer.

For browser work, connect a real model and ask it to open a page, inspect it or take a screenshot. Review the requested permissions. **Browser** shows the current page's screenshot when one is available. Offline demo does not launch a browser.

## Optional account and sync

In **Sync**, enter your server URL, email and password. Use **Create an account** when registering, then sign in.

- **Upload selected task** sends that task's prompt, selected file context and tool results to your server. API keys are excluded; review the content before uploading.
- **Download snapshots** retrieves remote task records for viewing. It does not replace local files. Use **Continue locally** to import a conversation, then inspect the selected workspace and start a fresh follow-up.
- **Sign out** ends your account session.

Local tasks and offline demo do not require an account. Ask your server administrator for the connection URL; server setup is outside this user guide.

See [Run, verify and resume](run-controls.md) for acceptance checks, live input, restart recovery, budgets and command access.
