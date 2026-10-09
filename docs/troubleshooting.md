# Troubleshooting

## The answer looks like a sample

Check whether **Demo mode · offline** is active. Demo uses predefined answers and sample files. For your own project, connect a model, open the workspace and start a new task. Continuing a demo conversation keeps it in demo mode.

## A model request failed

Check the selected provider, Base URL, model ID and API key. Confirm that the model is available to your account and that your service is reachable. If the message reports a limit, check your provider's account and retry later. Hikari does not switch failed requests to simulated answers.

## A task is waiting or will not continue

Look for a permission request in the timeline. Approve or deny it to continue. A paused task needs **Resume**. Tasks may also wait while another task uses the same workspace; let it finish or cancel it.

If a run reached its model-turn limit or stopped after repeated failures, read the result, narrow the request, then retry or send a follow-up. Increasing the turn limit alone may not resolve the underlying problem.

## A task was interrupted after restart

History is available, but unfinished tasks are not resumed automatically. Review the current files, then use **Retry** or a follow-up to continue deliberately.

## Diff review is disabled or Undo fails

Pause the task and wait until it is paused, or let it finish. If a file has changed since the recorded edit, inspect the newer changes before trying again. Undo multiple changes to a file in reverse order.

## Files or terminal show the wrong folder

Check the selected task and its workspace. A task in an isolated worktree uses that worktree; **New task** returns to a fresh conversation. Demo files are sample files. Open a real workspace for an interactive terminal; restart a terminal that has exited.

## Browser tools cannot open a page

Connect a real model, approve the browser request and check network access. For a source checkout, install the browser with `pnpm exec playwright install chromium`. Demo does not launch browsers.

## Sync fails

Confirm the server URL, account details and network connection. If a revision conflict is reported, download the latest snapshots and review them before uploading again. Downloads do not overwrite local project files. You can continue local tasks without sync.

## My interface or model settings changed

Open **Appearance & language** to restore your preferred theme or language. If the model connection is unavailable, enter it again in **Model settings**. Conversation content and tool output are not translated by the interface language setting.

## Attachments will not send

Preview the attachment and check its size and format. For scanned PDFs, attach page screenshots. For images, enable **This model accepts images** and use a vision-capable model. Sending errors preserve your draft; processing errors leave valid attachments in place. [See the attachment limits](attachments.md).
