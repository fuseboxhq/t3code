# Agent sub-threads

An agent running in a T3 Code thread can start more threads in the same project, hand each one a task, wait for them to finish, and read what they produced.
Those sub-threads are ordinary threads: they show in the sidebar nested under the thread that spawned them, and you can open them, read along, and type into them yourself.
The parent keeps its own context small by delegating the heavy lifting and only pulling back the result.

This is how you run one model as an orchestrator over others.
A Claude thread can spawn Codex sub-threads, a Codex thread can spawn Claude sub-threads, and any of them can spawn more of the same.

## Turn it on or off

Settings → Integrations → Agents → **Agent sub-threads**.
It is on by default.

The switch decides what a new agent session is allowed to do.
A session that is already running keeps whatever it was given when it started, so flipping the switch takes effect from the next turn that starts a fresh session.
With the switch off, the thread tools are simply absent from the agent's tool list; nothing fails, the agent just cannot see them.

## What the agent gets

The agent sees six tools, all under the `t3-code` MCP server (`mcp__t3-code__thread_spawn` in Claude, `thread_spawn` in Codex).

| Tool               | What it does                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `thread_spawn`     | Creates a sub-thread in the caller's project and sends it a first message. Returns straight away with the new thread id.       |
| `thread_wait`      | Blocks until the listed sub-threads finish their current turn, or until a timeout. Returns each thread's state and `timedOut`. |
| `thread_result`    | Returns the sub-thread's last completed assistant message plus its state.                                                      |
| `thread_send`      | Sends a follow-up message to a sub-thread, keeping its context. Sending while it is still working steers the current turn.     |
| `thread_list`      | Lists the caller's sub-threads and their state, optionally filtered by state.                                                  |
| `thread_interrupt` | Stops a sub-thread's current turn. The thread stays and can be resumed with `thread_send`.                                     |

`thread_spawn` takes a `prompt` and optional `title`, `provider`, `model`, `reasoningEffort`, `interactionMode` and `worktree`.
Anything left out is inherited: the project's default model, then the parent's own model; the parent's checkout.
Pass `provider: "codex"` on its own and the sub-thread runs on that provider's default model.
Pass `worktree: "new"` and the sub-thread gets a fresh git worktree branched from whatever branch the parent's checkout is on at that moment, which is the right choice when several sub-threads will edit files at once.
If that checkout is on a detached HEAD, the branch the thread was created with is used instead, and the spawn fails with a clear message if there is no branch at all.

The sub-thread state an agent sees is deliberately coarse: `starting`, `running`, `idle` or `failed`.
`idle` means the last turn finished and the thread is waiting for a follow-up.
`failed` comes with the session's last error.

## Limits

A thread can have at most 16 sub-threads.
A single `thread_wait` blocks for up to 25 minutes (10 by default); the agent calls it again to keep waiting, so long tasks are fine.
An agent can only see and talk to sub-threads it spawned itself; it cannot reach other threads in the project.
Sub-threads always run with full access, whatever mode the parent is in.
Nobody is watching a sub-thread to answer approval prompts, so any other mode would only stall it; if a task needs a human in the loop, run it as a normal thread instead.

## What you see in the sidebar

Sub-threads appear directly under their parent in the sidebar, indented one step per level, with the title the agent gave them (the first line of the prompt when it gave none).
They nest only while the parent is in the same section of the list: pin, snooze, or settle the parent and its sub-threads stay in the inbox as ordinary rows until it comes back.
Open one to watch it work or to step in and type; the parent's `thread_result` reads whatever the sub-thread last answered, whoever asked.
Deleting a sub-thread is the same as deleting any thread, and deleting the parent leaves its sub-threads in place.

## Teaching an agent to use it

The tools carry their own descriptions, so an agent will usually work out the spawn → wait → result loop on its own.
For a repeatable workflow, put the pattern in the agent's instructions (`CLAUDE.md`, `AGENTS.md` or a skill).
The two rules that matter most: give a sub-thread everything it needs in the prompt because it cannot see the parent's conversation, and always call `thread_wait` before `thread_result` so you read a finished answer rather than a half-streamed one.
