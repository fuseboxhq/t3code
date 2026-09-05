# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

## Group active threads by project

When **All projects** is selected on web or desktop, open its menu and turn on **Group active threads by project**.
Each project becomes an expandable section while pinned, Snoozed, and Settled threads keep their existing global sections.
Agent-spawned sub-threads appear under their parent thread while both are active.
Orphaned, cyclic, pinned, snoozed, and settled threads stay at the top level.
The setting is optional, persists across restarts, and can be turned off from the same menu to restore the flat thread list.
Collapsing a project keeps the thread you are viewing visible and shows a status indicator when another thread in the project needs attention.

A project header with open work on its repository shows a second line: an open pull request count and an open lead count, each behind its icon.
Click either count to open the Pull Requests or Leads page filtered to that project.
A count reads like "53+" when the repository holds more open work than one listing page can prove exactly.
Quiet projects keep their one-line header.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work. Drag pinned threads
to reorder them on web and desktop, or use **Move up** and **Move down** on mobile.
The order syncs across devices.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.

## Thread and project summaries

Each thread can have a short summary of what it is about, what has been done, and what is still in
flight; it appears once the first one has been generated. Open it from the summary button at the top
of the chat, next to the project actions, or choose **Summary** in a thread's context menu.
**Regenerate summary** in the same menu refreshes it on demand.

Summaries refresh on their own after each turn the agent finishes. In Settings under **Summaries**
you can switch this to also refresh every few minutes while a long turn is running, or turn the
automatic refresh off and keep summaries manual. The same section picks the model that writes them.

Each project rolls its active threads up into a project summary. Hover a project in the sidebar and
use the summary button next to **New thread**, or right-click the project and choose **Summary**.
The project summary refreshes shortly after any of its thread summaries change.

While a summary is being written the button shows a spinner and the menu actions read
**Summarising…**. Summaries are hidden when the connected environment needs a server update.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement, but an old closed or merged pull request does not settle work you
resumed after it closed.

Change these rules in **Settings → General**. They continue to run when your apps
are closed. Changes apply to connected environments that support shared settings;
offline environments and older servers keep their previous values. If connected
environments disagree, **Apply to all** copies your current settings to those named
in the warning. Changing a rule does not reopen already settled threads.

## Link a pull request

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread**. Use **Unlink from thread** on the same link to remove it.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

On web and desktop, use **Agents** to follow work delegated to subagents.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.
