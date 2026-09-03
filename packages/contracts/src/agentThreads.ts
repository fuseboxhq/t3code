/**
 * Schemas for the `thread_*` MCP tools an agent uses to spawn and follow
 * sub-threads inside its own project. Kept separate from the orchestration
 * commands because these are the agent-facing shapes: small, prose-described,
 * and stable across server versions.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AGENT_THREAD_WAIT_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const AGENT_THREAD_WAIT_MAX_TIMEOUT_MS = 25 * 60 * 1000;
export const AGENT_THREAD_MAX_CHILDREN = 16;
/**
 * How long provider CLIs should let a single T3 Code MCP tool call run.
 * `thread_wait` blocks for up to its max timeout, so the client-side limit
 * has to sit above that or the wait is killed before it can report.
 */
export const AGENT_MCP_TOOL_TIMEOUT_MS = AGENT_THREAD_WAIT_MAX_TIMEOUT_MS + 60 * 1000;

const ThreadIdList = Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(64));

export const AgentThreadWorktreeMode = Schema.Literals(["inherit", "new"]).annotate({
  description:
    "'inherit' runs the sub-thread in the same checkout as the caller; 'new' creates a fresh git worktree branched from the caller's branch.",
});
export type AgentThreadWorktreeMode = typeof AgentThreadWorktreeMode.Type;

export const AgentThreadSpawnInput = Schema.Struct({
  prompt: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "The first user message for the sub-thread. Be explicit: the sub-thread has none of your context.",
  }),
  title: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Sidebar title. Defaults to the first line of the prompt.",
  }),
  provider: Schema.optional(ProviderInstanceId).annotate({
    description:
      "Provider instance id to run the sub-thread on (for example 'codex' or 'claudeAgent'). Defaults to the project's default model, then the caller's own provider.",
  }),
  model: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Model slug on the chosen provider. Defaults to that provider's default model.",
  }),
  reasoningEffort: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "Reasoning effort for the model, using the provider's own option ids (for example 'high', 'xhigh', 'max'). Ignored when the model has no effort option.",
  }),
  interactionMode: Schema.optional(ProviderInteractionMode).annotate({
    description: "'default' or 'plan'. Defaults to 'default'.",
  }),
  worktree: Schema.optional(AgentThreadWorktreeMode).annotate({
    description: "Where the sub-thread runs. Defaults to 'inherit'.",
  }),
});
export type AgentThreadSpawnInput = typeof AgentThreadSpawnInput.Type;

export const AgentThreadTargetInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "A sub-thread you spawned." }),
});
export type AgentThreadTargetInput = typeof AgentThreadTargetInput.Type;

export const AgentThreadSendInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "A sub-thread you spawned." }),
  prompt: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "The follow-up user message. Sending while the sub-thread is still running steers the current turn.",
  }),
});
export type AgentThreadSendInput = typeof AgentThreadSendInput.Type;

export const AgentThreadWaitMode = Schema.Literals(["all", "any"]);
export type AgentThreadWaitMode = typeof AgentThreadWaitMode.Type;

export const AgentThreadWaitInput = Schema.Struct({
  threadIds: ThreadIdList.annotate({ description: "Sub-threads you spawned." }),
  mode: Schema.optional(AgentThreadWaitMode).annotate({
    description:
      "'all' returns once every listed sub-thread is idle; 'any' returns as soon as one is. Defaults to 'all'.",
  }),
  timeoutMs: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1_000),
      Schema.isLessThanOrEqualTo(AGENT_THREAD_WAIT_MAX_TIMEOUT_MS),
    ),
  ).annotate({
    description: `How long to block before returning with timedOut=true. Defaults to ${AGENT_THREAD_WAIT_DEFAULT_TIMEOUT_MS} ms; capped at ${AGENT_THREAD_WAIT_MAX_TIMEOUT_MS} ms. Call again to keep waiting.`,
  }),
});
export type AgentThreadWaitInput = typeof AgentThreadWaitInput.Type;

/**
 * Coarse lifecycle as the orchestrating agent sees it. `idle` means the last
 * turn finished and the sub-thread is waiting for a follow-up; `failed`
 * carries `lastError`.
 */
export const AgentThreadState = Schema.Literals(["starting", "running", "idle", "failed"]);
export type AgentThreadState = typeof AgentThreadState.Type;

// MCP clients require a tool's input schema to be a JSON object with
// properties; an empty struct encodes as a bare `anyOf` that the Claude
// client rejects, taking every tool on the server down with it.
export const AgentThreadListInput = Schema.Struct({
  state: Schema.optional(AgentThreadState).annotate({
    description: "Only return sub-threads currently in this state. Omit for all of them.",
  }),
});
export type AgentThreadListInput = typeof AgentThreadListInput.Type;

export const AgentThreadSummary = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  state: AgentThreadState,
  provider: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  /** True once the thread was explicitly settled (moved to the sidebar's settled shelf). */
  settled: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentThreadSummary = typeof AgentThreadSummary.Type;

export const AgentThreadSpawnResult = Schema.Struct({
  thread: AgentThreadSummary,
  messageId: MessageId,
});
export type AgentThreadSpawnResult = typeof AgentThreadSpawnResult.Type;

export const AgentThreadSendResult = AgentThreadSpawnResult;
export type AgentThreadSendResult = typeof AgentThreadSendResult.Type;

export const AgentThreadWaitResult = Schema.Struct({
  threads: Schema.Array(AgentThreadSummary),
  timedOut: Schema.Boolean,
});
export type AgentThreadWaitResult = typeof AgentThreadWaitResult.Type;

export const AgentThreadResult = Schema.Struct({
  thread: AgentThreadSummary,
  /** Text of the last completed assistant message anywhere in the thread, or null if there is none yet. */
  finalMessage: Schema.NullOr(Schema.String),
  finalMessageId: Schema.NullOr(MessageId),
  /** Every message in the thread across all turns. */
  messageCount: Schema.Int,
});
export type AgentThreadResult = typeof AgentThreadResult.Type;

export const AgentThreadListResult = Schema.Struct({
  threads: Schema.Array(AgentThreadSummary),
});
export type AgentThreadListResult = typeof AgentThreadListResult.Type;

export const AgentThreadInterruptResult = Schema.Struct({
  thread: AgentThreadSummary,
});
export type AgentThreadInterruptResult = typeof AgentThreadInterruptResult.Type;

export const AgentThreadSettleResult = Schema.Struct({
  thread: AgentThreadSummary,
});
export type AgentThreadSettleResult = typeof AgentThreadSettleResult.Type;

const AgentThreadErrorScope = {
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectId: Schema.optional(ProjectId),
};

/** The credential was minted without the `threads` capability. */
export class AgentThreadUnavailableError extends Schema.TaggedErrorClass<AgentThreadUnavailableError>()(
  "AgentThreadUnavailableError",
  AgentThreadErrorScope,
) {
  override get message(): string {
    return "MCP credential does not grant the threads capability.";
  }
}

/** The target is not a sub-thread the caller spawned, or no longer exists. */
export class AgentThreadNotFoundError extends Schema.TaggedErrorClass<AgentThreadNotFoundError>()(
  "AgentThreadNotFoundError",
  { ...AgentThreadErrorScope, targetThreadId: ThreadId },
) {
  override get message(): string {
    return `Thread '${this.targetThreadId}' is not a sub-thread of '${this.threadId}'.`;
  }
}

export class AgentThreadInvalidInputError extends Schema.TaggedErrorClass<AgentThreadInvalidInputError>()(
  "AgentThreadInvalidInputError",
  { ...AgentThreadErrorScope, detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return this.detail;
  }
}

export class AgentThreadDispatchError extends Schema.TaggedErrorClass<AgentThreadDispatchError>()(
  "AgentThreadDispatchError",
  { ...AgentThreadErrorScope, operation: TrimmedNonEmptyString, detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return `${this.operation} failed: ${this.detail}`;
  }
}

export const AgentThreadError = Schema.Union([
  AgentThreadUnavailableError,
  AgentThreadNotFoundError,
  AgentThreadInvalidInputError,
  AgentThreadDispatchError,
]);
export type AgentThreadError = typeof AgentThreadError.Type;
