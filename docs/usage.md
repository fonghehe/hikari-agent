# Tasks and workspace

## Start and find tasks

Click **New task** or press **⌘N / Ctrl+N** to start a fresh conversation. Enter a goal and send it with **Enter**; **Shift+Enter** inserts a new line. Cancelling the folder picker preserves your draft.

Use **Task history** beside **Recent** to browse history. Search by task title or workspace and select a task to see its conversation and results. Your history remains available after restarting Hikari; interrupted tasks are not resumed automatically.

Projects appear above **Recent**, with their conversations nested beneath them. Click a project to expand or collapse its chats; use its compose icon to start a new chat. The **+** button opens **Create project**: enter a name, add a source folder, and confirm creation. Choosing a folder only stages its path; cancelling leaves projects and the active workspace intact. The source menu also offers a file picker and manual absolute paths. A file imports its containing folder. Paths and filesystem aliases that resolve to the same folder share one project. Different folders with the same name remain separate and show their distinguishing parent paths.

Use **… → Organize sidebar** to switch between **By project** and **Combined view**. Combined view lists regular project and standalone chats together while retaining pinned items and custom sections. **Chat sort order** offers **Recently updated** and **Manual order**. Drag chats or focus one and press **Alt + Up/Down** to reorder manually. Display choices and manual positions are saved on this device; new chats appear first. In combined view, **Task history** appears below the chat list.

Right-click a project, or focus it and press **Shift+F10**, to open **Pin project**, **Edit**, **Section**, **Archive chats**, and **Remove project**. Pinning and sections persist across restarts. Archiving affects only finished conversations in that project; active tasks must finish or be cancelled first. Removal hides the project and its sidebar conversations while preserving files and all records in **Task history**. Add the same folder or one of its files again to restore the association and the saved name. **New chat** beside **Recent** starts a conversation without project access. Follow-ups retain their original project after switching projects.

Project removal requires confirmation in both the context menu and the editor. **Cancel** is focused by default; no files or records are deleted.

Right-click any sidebar conversation to rename, pin, mark unread, move to a section, fork, share, copy, open in a new window, choose an external opener, archive, or permanently delete it. Forks copy saved conversation content without starting the model or resuming execution. A Git project conversation can also fork into a new worktree from its current working files; an existing isolated worktree can fork a conversation in the same worktree. Sharing offers copied Markdown or a local export, without uploading content or creating a public link. Permanent deletion requires confirmation; isolated worktrees must be archived first.

Custom sections appear above pinned items, projects and recent chats. Click the section heading to expand or collapse it; the collapsed state is remembered on this device. The compose icon opens a new conversation in that section. New conversations, follow-ups and retries retain their section. Search temporarily reveals matching section content.

The **…** button or context menu on a custom section offers **Edit**, **Mark all as read**, **Archive chats**, **New section…**, and **Remove section**. Empty sections persist. Removing a section returns its projects and conversations to their default groups while retaining history and files. Section archives include nested project chats; active tasks must finish or be cancelled first.

**Project chats → Memory & extensions** opens that project’s fixed-height window with **Memory**, **Extensions**, and **Automation and integrations** tabs. Its entry is below the input box in a project conversation, including a new conversation in that project. Global data maintenance and updates are in **Settings → Data & updates**. Tab content scrolls internally so switching tabs keeps the window in place.

## Plan and execute

Open **Task options** beside the composer to choose the mode, turn limit and worktree option. Expand **Acceptance and budgets** for additional controls:

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
- **Follow-up prompt** continues a finished, failed or cancelled task. Choose the next mode in **Task options** beside the follow-up input. **Previous turn** returns to the earlier conversation.

## Approve an operation

Read the tool name, arguments and target workspace before choosing **Allow once**, **Allow for session**, **Always allow**, or **Deny**. Only grant lasting permission when you trust the operation. Agent commands use the selected OS sandbox or host access. External connections require approval.

## Read files and review changes

Open **Workspace tools → Files** for the selected task. Folders start collapsed. Click a folder to expand it or use **Expand one level** to reveal another source level; dependency and generated folders are skipped by that action. **Collapse all** folds the tree. Click a file to read it in the read-only viewer.

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

Open the **Settings → Account & sync** dialog and enter your server URL, email and password. Use **Create an account** when registering, then sign in.

- **Upload selected task** sends that task's prompt, selected file context and tool results to your server. API keys are excluded; review the content before uploading.
- **Download snapshots** retrieves remote task records for viewing. It does not replace local files. Use **Continue locally** to import a conversation, then inspect the selected workspace and start a fresh follow-up.
- **Sign out** ends your account session.

Local tasks and offline demo do not require an account. Ask your server administrator for the connection URL; server setup is outside this user guide.

See [Run, verify and resume](run-controls.md) for acceptance checks, live input, restart recovery, budgets and command access.
