# Agent sub-threads

Agent sub-threads let a provider session spawn more threads in its own project through the agent-facing MCP server, then wait on them and read their answers.
The user-facing description is in [docs/user/agent-subthreads.md](../user/agent-subthreads.md); this page is the shape of the implementation.

## Shape

- `packages/contracts/src/agentThreads.ts` - the agent-facing schemas for the six `thread_*` tools, the coarse `AgentThreadState`, the timeout and child-count constants, and the tagged error union.
  These are the wire shapes an agent sees, so they are prose-annotated and kept separate from the orchestration commands.
- `packages/contracts/src/orchestration.ts` - `parentThreadId` on the thread, thread shell, `thread.create` command, bootstrap create block, and `thread.created` event.
  Optional everywhere so payloads from a server without the feature still decode.
- `apps/server/src/orchestration/ThreadBootstrap.ts` - the create / worktree / setup-script / turn-start sequence that used to live inline in `ws.ts`.
  The WebSocket dispatch path and the MCP tools both go through it, so a spawned sub-thread is bootstrapped exactly like one started from the composer.
- `apps/server/src/mcp/toolkits/threads/` - `tools.ts` declares the toolkit, `handlers.ts` implements it, `resolve.ts` holds the pure helpers (model resolution, state derivation, title from prompt).
- `apps/server/src/persistence/Migrations/045_ProjectionThreadsParent.ts` - `projection_threads.parent_thread_id` plus its index.
- `ExecutionEnvironmentCapabilities.agentSubthreads` - the environment flag clients check before nesting threads in the sidebar; absent on older servers.

## Capability gating

An MCP credential is minted per thread when a provider session starts (`prepareMcpSession` in `ProviderService.ts`).
The credential carries a `capabilities` set, currently `preview` and `threads`, granted from the `enableAgentBrowserAccess` and `enableAgentSubthreads` settings at mint time.
When neither is granted no credential is minted and the adapter does not register the `t3-code` MCP server at all.

Every toolkit is always registered on the HTTP server; the handler reads `McpInvocationContext.capabilities` and fails with `AgentThreadUnavailableError` when `threads` is missing.
This is why turning the setting off only affects sessions started afterwards: a running session keeps the credential it was given.

## Scoping

Every `thread_*` handler resolves the calling thread from the invocation context and refuses any target whose `parentThreadId` is not the caller.
An agent can only wait on, read, message, or interrupt threads it spawned.
Spawning is capped at `AGENT_THREAD_MAX_CHILDREN` (16) live children per parent, counted from the projection.

`thread_spawn` inherits from the parent: model selection resolves as project default, then the parent's own selection, with explicit `provider` / `model` / `reasoningEffort` overriding field by field (`resolveSpawnModelSelection`).
`runtimeMode` defaults to the parent's; `worktree: "new"` creates a worktree branched from the parent's branch through the same bootstrap block the composer uses.

## State derivation

Agents do not get the raw session status.
`deriveAgentThreadState` collapses it to `starting` / `running` / `idle` / `failed`, treating a trailing user message or a streaming assistant message as busy even when the session still reports `ready` or `stopped` from the previous turn.
That closes the gap right after `thread_send`, where a naive read of session status would report the thread as finished before the provider has picked the message up.

`thread_wait` re-reads the watched threads on every domain event that touches one of them, with a periodic tick as a backstop, and returns `timedOut: true` rather than erroring once the caller's timeout (capped at `AGENT_THREAD_WAIT_MAX_TIMEOUT_MS`, 25 minutes) elapses, so an orchestrator loops on it.
Both provider adapters raise their client-side MCP tool timeout to `AGENT_MCP_TOOL_TIMEOUT_MS` (max wait plus a minute): Codex through `mcp_servers.t3-code.tool_timeout_sec`, Claude through `MCP_TOOL_TIMEOUT`.
Without that the client kills the wait before it can report.

## MCP input schemas must be objects

MCP clients validate every advertised tool's `inputSchema` as `{ "type": "object", ... }`.
An empty `Schema.Struct({})` encodes through `Tool.getJsonSchema` as `anyOf: [object, array]`, and the Claude client responds by dropping every tool on the server, preview tools included, with no error surfaced to the agent.
`thread_list` therefore takes an optional `state` filter rather than no input, and `apps/server/src/mcp/toolkits/tools.test.ts` asserts the object shape for every toolkit so the next zero-argument tool fails in CI instead of in a live session.

## Client expectations

Clients nest a thread under its `parentThreadId` in the sidebar only when the environment reports `agentSubthreads`.
Sub-threads are otherwise ordinary threads: they can be opened, typed into, and deleted, and deleting the parent does not cascade.
