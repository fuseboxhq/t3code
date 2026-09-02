import {
  AGENT_THREAD_MAX_CHILDREN,
  AGENT_THREAD_WAIT_DEFAULT_TIMEOUT_MS,
  AgentThreadDispatchError,
  AgentThreadInvalidInputError,
  AgentThreadNotFoundError,
  AgentThreadUnavailableError,
  CommandId,
  MessageId,
  ThreadId,
  type AgentThreadListInput,
  type AgentThreadSpawnInput,
  type AgentThreadSummary,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ThreadTurnStartBootstrap,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBootstrap from "../../../orchestration/ThreadBootstrap.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { eventThreadId } from "../../../relay/AgentAwarenessRelay.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  isSettledAgentThreadState,
  lastCompletedAssistantMessage,
  resolveSpawnModelSelection,
  summarizeAgentThread,
  titleFromPrompt,
} from "./resolve.ts";
import { ThreadToolkit } from "./tools.ts";

/** Fallback re-check cadence for thread_wait, in case an event slips past the subscription. */
const WAIT_POLL_INTERVAL = Duration.seconds(5);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const requireThreadsScope = Effect.fn("ThreadToolkit.requireScope")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("threads")) {
    return yield* new AgentThreadUnavailableError({
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
    });
  }
  return invocation;
});

type ThreadsScope = McpInvocationContext.McpInvocationScope;

const describe = (cause: unknown): string =>
  typeof cause === "object" &&
  cause !== null &&
  "message" in cause &&
  typeof cause.message === "string"
    ? cause.message
    : String(cause);

const dispatchFailure = (scope: ThreadsScope, operation: string) => (cause: unknown) =>
  new AgentThreadDispatchError({
    environmentId: scope.environmentId,
    threadId: scope.threadId,
    operation,
    detail: describe(cause),
  });

const invalidInput = (scope: ThreadsScope, detail: string) =>
  new AgentThreadInvalidInputError({
    environmentId: scope.environmentId,
    threadId: scope.threadId,
    detail,
  });

const notFound = (scope: ThreadsScope, targetThreadId: ThreadId) =>
  new AgentThreadNotFoundError({
    environmentId: scope.environmentId,
    threadId: scope.threadId,
    targetThreadId,
  });

const isChildOf = (scope: ThreadsScope, thread: OrchestrationThreadShell | OrchestrationThread) =>
  thread.parentThreadId === scope.threadId;

/** The caller's own thread; the only anchor every other lookup is scoped by. */
const loadParent = Effect.fn("ThreadToolkit.loadParent")(function* (scope: ThreadsScope) {
  const query = yield* ProjectionSnapshotQuery;
  const shell = yield* query
    .getThreadShellById(scope.threadId)
    .pipe(Effect.mapError(dispatchFailure(scope, "read parent thread")));
  if (Option.isNone(shell)) {
    return yield* notFound(scope, scope.threadId);
  }
  return shell.value;
});

/**
 * Detail read bounded to the latest turn: enough to tell whether a turn is
 * in flight and to read the last assistant message, without hydrating the
 * whole transcript on every wait tick.
 */
const loadChild = Effect.fn("ThreadToolkit.loadChild")(function* (
  scope: ThreadsScope,
  targetThreadId: ThreadId,
) {
  const query = yield* ProjectionSnapshotQuery;
  const snapshot = yield* query
    .getThreadDetailSnapshot(targetThreadId, { turnLimit: 1 })
    .pipe(Effect.mapError(dispatchFailure(scope, "read sub-thread")));
  if (
    Option.isNone(snapshot) ||
    snapshot.value.thread.deletedAt !== null ||
    !isChildOf(scope, snapshot.value.thread)
  ) {
    return yield* notFound(scope, targetThreadId);
  }
  return snapshot.value.thread;
});

const summarizeChild = (thread: OrchestrationThread): AgentThreadSummary =>
  summarizeAgentThread(thread, thread.messages.at(-1));

const serverIds = Effect.fn("ThreadToolkit.serverIds")(function* (
  scope: ThreadsScope,
  tag: string,
) {
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.mapError(dispatchFailure(scope, "generate id")));
  return {
    commandId: CommandId.make(`server:mcp-thread-${tag}:${yield* uuid}`),
    messageId: MessageId.make(yield* uuid),
    threadId: ThreadId.make(yield* uuid),
    hex: (yield* uuid).replaceAll("-", ""),
  };
});

const resolveModel = Effect.fn("ThreadToolkit.resolveModel")(function* (
  scope: ThreadsScope,
  input: AgentThreadSpawnInput,
  parent: OrchestrationThreadShell,
) {
  const query = yield* ProjectionSnapshotQuery;
  const providers = yield* (yield* ProviderRegistry).getProviders;
  const settings = yield* ServerSettingsService;
  const project = yield* query
    .getProjectShellById(parent.projectId)
    .pipe(Effect.mapError(dispatchFailure(scope, "read project")));
  if (Option.isNone(project)) {
    return yield* invalidInput(scope, `Project '${parent.projectId}' no longer exists.`);
  }
  // A missing settings file only costs the workspace default; the parent's
  // own selection still anchors the fallback chain.
  const workspaceDefault = yield* settings.getSettings.pipe(
    Effect.map((entry) => entry.newThreadModelSelection),
    Effect.orElseSucceed(() => null),
  );
  const resolution = resolveSpawnModelSelection({
    input,
    providers,
    defaults: [project.value.defaultModelSelection, workspaceDefault, parent.modelSelection],
  });
  if (!resolution.ok) {
    return yield* invalidInput(scope, resolution.detail);
  }
  return { project: project.value, modelSelection: resolution.selection };
});

const threadSpawn = Effect.fn("ThreadToolkit.spawn")(function* (input: AgentThreadSpawnInput) {
  const scope = yield* requireThreadsScope();
  const parent = yield* loadParent(scope);
  const query = yield* ProjectionSnapshotQuery;
  const siblings = yield* query
    .getShellSnapshot()
    .pipe(Effect.mapError(dispatchFailure(scope, "read threads")));
  const childCount = siblings.threads.filter((thread) => isChildOf(scope, thread)).length;
  if (childCount >= AGENT_THREAD_MAX_CHILDREN) {
    return yield* invalidInput(
      scope,
      `This thread already has ${childCount} sub-threads; the limit is ${AGENT_THREAD_MAX_CHILDREN}.`,
    );
  }

  const { project, modelSelection } = yield* resolveModel(scope, input, parent);
  const ids = yield* serverIds(scope, "spawn");
  const createdAt = yield* nowIso;
  const runtimeMode = input.runtimeMode ?? parent.runtimeMode;
  const interactionMode = input.interactionMode ?? "default";
  const title = input.title ?? titleFromPrompt(input.prompt);

  let bootstrap: ThreadTurnStartBootstrap;
  if (input.worktree === "new") {
    const git = yield* GitWorkflowService.GitWorkflowService;
    const baseBranch =
      parent.branch ??
      (yield* git
        .localStatus({ cwd: project.workspaceRoot })
        .pipe(Effect.mapError(dispatchFailure(scope, "read git status")))).refName;
    if (baseBranch === null) {
      return yield* invalidInput(
        scope,
        "Cannot create a worktree: the project has no current branch.",
      );
    }
    bootstrap = {
      createThread: {
        projectId: parent.projectId,
        title,
        modelSelection,
        runtimeMode,
        interactionMode,
        branch: baseBranch,
        worktreePath: null,
        parentThreadId: scope.threadId,
        createdAt,
      },
      prepareWorktree: {
        projectCwd: project.workspaceRoot,
        baseBranch,
        branch: buildTemporaryWorktreeBranchName(() => ids.hex),
      },
      runSetupScript: true,
    };
  } else {
    bootstrap = {
      createThread: {
        projectId: parent.projectId,
        title,
        modelSelection,
        runtimeMode,
        interactionMode,
        branch: parent.branch,
        worktreePath: parent.worktreePath,
        parentThreadId: scope.threadId,
        createdAt,
      },
    };
  }

  const threadBootstrap = yield* ThreadBootstrap.ThreadBootstrap;
  yield* threadBootstrap
    .dispatchTurnStart({
      type: "thread.turn.start",
      commandId: ids.commandId,
      threadId: ids.threadId,
      message: { messageId: ids.messageId, role: "user", text: input.prompt, attachments: [] },
      modelSelection,
      runtimeMode,
      interactionMode,
      bootstrap,
      createdAt,
    })
    .pipe(Effect.mapError(dispatchFailure(scope, "spawn sub-thread")));

  const child = yield* loadChild(scope, ids.threadId);
  return { thread: summarizeChild(child), messageId: ids.messageId };
});

const threadSend = Effect.fn("ThreadToolkit.send")(function* (input: {
  readonly threadId: ThreadId;
  readonly prompt: string;
}) {
  const scope = yield* requireThreadsScope();
  const child = yield* loadChild(scope, input.threadId);
  const ids = yield* serverIds(scope, "send");
  const createdAt = yield* nowIso;
  const threadBootstrap = yield* ThreadBootstrap.ThreadBootstrap;
  yield* threadBootstrap
    .dispatchTurnStart({
      type: "thread.turn.start",
      commandId: ids.commandId,
      threadId: child.id,
      message: { messageId: ids.messageId, role: "user", text: input.prompt, attachments: [] },
      modelSelection: child.modelSelection,
      runtimeMode: child.runtimeMode,
      interactionMode: child.interactionMode,
      createdAt,
    })
    .pipe(Effect.mapError(dispatchFailure(scope, "message sub-thread")));
  const updated = yield* loadChild(scope, child.id);
  return { thread: summarizeChild(updated), messageId: ids.messageId };
});

const threadWait = Effect.fn("ThreadToolkit.wait")(function* (input: {
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly mode?: "all" | "any" | undefined;
  readonly timeoutMs?: number | undefined;
}) {
  const scope = yield* requireThreadsScope();
  const engine = yield* OrchestrationEngineService;
  const watched = new Set(input.threadIds);
  const mode = input.mode ?? "all";

  const readAll = Effect.forEach(
    [...watched],
    (threadId) => loadChild(scope, threadId).pipe(Effect.map(summarizeChild)),
    { concurrency: 4 },
  );
  const isDone = (threads: ReadonlyArray<AgentThreadSummary>) =>
    mode === "any"
      ? threads.some((thread) => isSettledAgentThreadState(thread.state))
      : threads.every((thread) => isSettledAgentThreadState(thread.state));

  // Subscribe before the first read so nothing lands in between; the poll
  // tick covers the remaining window where a read races the subscription.
  const wakeups = Stream.merge(
    Stream.tick(WAIT_POLL_INTERVAL),
    engine.streamDomainEvents.pipe(
      Stream.filter((event: OrchestrationEvent) => {
        const threadId = eventThreadId(event);
        return threadId !== null && watched.has(threadId);
      }),
      Stream.map(() => undefined),
    ),
  );
  const settled = wakeups.pipe(
    Stream.mapEffect(() => readAll, { concurrency: 1 }),
    Stream.filter(isDone),
    Stream.take(1),
    Stream.runHead,
    Effect.timeoutOption(Duration.millis(input.timeoutMs ?? AGENT_THREAD_WAIT_DEFAULT_TIMEOUT_MS)),
    Effect.map(Option.flatten),
  );

  const result = yield* settled;
  if (Option.isSome(result)) {
    return { threads: result.value, timedOut: false };
  }
  return { threads: yield* readAll, timedOut: true };
});

const threadResult = Effect.fn("ThreadToolkit.result")(function* (input: {
  readonly threadId: ThreadId;
}) {
  const scope = yield* requireThreadsScope();
  const child = yield* loadChild(scope, input.threadId);
  const final = lastCompletedAssistantMessage(child.messages);
  return {
    thread: summarizeChild(child),
    finalMessage: final?.text ?? null,
    finalMessageId: final?.id ?? null,
    messageCount: child.messages.length,
  };
});

const threadList = Effect.fn("ThreadToolkit.list")(function* (input: AgentThreadListInput) {
  const scope = yield* requireThreadsScope();
  const query = yield* ProjectionSnapshotQuery;
  const snapshot = yield* query
    .getShellSnapshot()
    .pipe(Effect.mapError(dispatchFailure(scope, "read threads")));
  const children = snapshot.threads.filter((thread) => isChildOf(scope, thread));
  const threads = yield* Effect.forEach(
    children,
    (shell) => loadChild(scope, shell.id).pipe(Effect.map(summarizeChild)),
    { concurrency: 4 },
  );
  return {
    threads:
      input.state === undefined ? threads : threads.filter((entry) => entry.state === input.state),
  };
});

const threadInterrupt = Effect.fn("ThreadToolkit.interrupt")(function* (input: {
  readonly threadId: ThreadId;
}) {
  const scope = yield* requireThreadsScope();
  const child = yield* loadChild(scope, input.threadId);
  const engine = yield* OrchestrationEngineService;
  const ids = yield* serverIds(scope, "interrupt");
  yield* engine
    .dispatch({
      type: "thread.turn.interrupt",
      commandId: ids.commandId,
      threadId: child.id,
      createdAt: yield* nowIso,
    })
    .pipe(Effect.mapError(dispatchFailure(scope, "interrupt sub-thread")));
  const updated = yield* loadChild(scope, child.id);
  return { thread: summarizeChild(updated) };
});

const handlers = {
  thread_spawn: (input) => threadSpawn(input),
  thread_wait: (input) => threadWait(input),
  thread_result: (input) => threadResult(input),
  thread_send: (input) => threadSend(input),
  thread_list: (input) => threadList(input),
  thread_interrupt: (input) => threadInterrupt(input),
} satisfies Parameters<typeof ThreadToolkit.toLayer>[0];

export const ThreadToolkitHandlersLive = ThreadToolkit.toLayer(handlers);
