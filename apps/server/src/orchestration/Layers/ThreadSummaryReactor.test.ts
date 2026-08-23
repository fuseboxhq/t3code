import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { describe, expect, vi } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration, type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadSummaryReactor } from "../Services/ThreadSummaryReactor.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { make as makeThreadSummaryReactor } from "./ThreadSummaryReactor.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-luna" };

const generateThreadSummary = vi.fn<TextGenerationShape["generateThreadSummary"]>();
const generateProjectSummary = vi.fn<TextGenerationShape["generateProjectSummary"]>();

const resetMocks = () => {
  generateThreadSummary.mockReset();
  generateThreadSummary.mockImplementation(() => Effect.succeed({ summary: "Thread digest" }));
  generateProjectSummary.mockReset();
  generateProjectSummary.mockImplementation(() => Effect.succeed({ summary: "Project digest" }));
};

const orchestrationLayer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
);
const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
);
const makeTestLayer = (options: Parameters<typeof makeThreadSummaryReactor>[0]) =>
  Layer.effect(
    ThreadSummaryReactor,
    makeThreadSummaryReactor({ projectRollupDebounce: Duration.millis(20), ...options }),
  ).pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotLayer),
    Layer.provideMerge(
      Layer.mock(TextGeneration, { generateThreadSummary, generateProjectSummary }),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-summary-reactor-" })),
    Layer.provideMerge(NodeServices.layer),
  );
const TestLayer = makeTestLayer({});
const LiveTestLayer = makeTestLayer({ liveRefreshInterval: Duration.millis(30) });

const waitFor = <E>(predicate: Effect.Effect<boolean, E>, timeoutMs = 5_000) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while (!(yield* predicate)) {
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.die(new Error("waitFor timed out"));
      }
      yield* Effect.yieldNow;
    }
  });

/** Let queued reactor work settle so a "nothing happened" assertion is meaningful. */
const settle = Effect.sleep("50 millis");

/** One project with one thread that has a single user message, keyed by suffix so tests stay apart. */
const seed = (suffix: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const projectId = ProjectId.make(`project-${suffix}`);
    const threadId = ThreadId.make(`thread-${suffix}`);
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-create-${suffix}`),
      projectId,
      title: "Summary Project",
      workspaceRoot: `/tmp/summary-project-${suffix}`,
      defaultModelSelection: MODEL,
      createdAt: NOW,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-create-${suffix}`),
      threadId,
      projectId,
      title: "Thread",
      modelSelection: MODEL,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    });
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`cmd-turn-start-${suffix}`),
      threadId,
      message: {
        messageId: MessageId.make(`user-message-${suffix}`),
        role: "user",
        text: "Please fix the reconnect bug",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: NOW,
    });
    const completeTurn = (turnId: string, commandId: string) =>
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make(commandId),
        threadId,
        turnId: TurnId.make(turnId),
        completedAt: NOW,
        checkpointRef: CheckpointRef.make(`ref-${turnId}`),
        status: "missing",
        files: [],
        checkpointTurnCount: 1,
        createdAt: NOW,
      });
    const requestSummary = (commandId: string) =>
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(commandId),
        threadId,
        regenerateSummary: true,
      });
    const readThread = snapshotQuery
      .getSnapshot()
      .pipe(Effect.map((snapshot) => snapshot.threads.find((thread) => thread.id === threadId)));
    const readProject = snapshotQuery
      .getSnapshot()
      .pipe(
        Effect.map((snapshot) => snapshot.projects.find((project) => project.id === projectId)),
      );
    return { completeTurn, requestSummary, readThread, readProject };
  });

/** Each test gets a fresh in-memory engine and its own reactor scope; live clock so the rollup debounce fires. */
const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof TestLayer> | Scope.Scope>,
  layer: typeof TestLayer = TestLayer,
) => Effect.scoped(effect).pipe(Effect.provide(layer));

describe("ThreadSummaryReactor", () => {
  it.live("summarises on turn end, skips when nothing changed, and rolls up the project", () =>
    run(
      Effect.gen(function* () {
        resetMocks();
        const reactor = yield* ThreadSummaryReactor;
        const h = yield* seed("turn-end");
        yield* reactor.start();

        yield* h.completeTurn("turn-1", "cmd-turn-diff-1");
        yield* waitFor(
          h.readThread.pipe(Effect.map((thread) => thread?.summary?.text === "Thread digest")),
        );
        expect(generateThreadSummary).toHaveBeenCalledTimes(1);
        expect(generateThreadSummary.mock.calls[0]?.[0]).toMatchObject({
          previousSummary: undefined,
          modelSelection: { model: "gpt-5.6-luna" },
        });
        expect(generateThreadSummary.mock.calls[0]?.[0].context).toContain(
          "Please fix the reconnect bug",
        );
        const thread = yield* h.readThread;
        expect(thread?.summaryGeneration).toBeNull();
        expect(thread?.summary?.basis.messageCount).toBe(1);

        // The rollup fires after the debounce window from the thread summary landing.
        yield* waitFor(
          h.readProject.pipe(Effect.map((project) => project?.summary?.text === "Project digest")),
        );
        expect(generateProjectSummary.mock.calls[0]?.[0].context).toContain("Thread digest");

        // Same turn, no new messages: the summary is current, so no second call.
        yield* h.completeTurn("turn-1", "cmd-turn-diff-1-again");
        yield* reactor.drain;
        yield* settle;
        expect(generateThreadSummary).toHaveBeenCalledTimes(1);
      }),
    ),
  );

  it.live("clears the pending marker when generation fails", () =>
    run(
      Effect.gen(function* () {
        resetMocks();
        generateThreadSummary.mockImplementation(() =>
          Effect.fail(
            new TextGenerationError({ operation: "generateThreadSummary", detail: "boom" }),
          ),
        );
        const reactor = yield* ThreadSummaryReactor;
        const h = yield* seed("failure");
        yield* reactor.start();

        yield* h.requestSummary("cmd-summary-request-failure");
        yield* waitFor(Effect.sync(() => generateThreadSummary.mock.calls.length === 1));
        yield* waitFor(
          h.readThread.pipe(Effect.map((thread) => thread?.summaryGeneration == null)),
        );
        expect((yield* h.readThread)?.summary ?? null).toBeNull();
      }),
    ),
  );

  it.live("drops a result whose request is no longer current", () =>
    run(
      Effect.gen(function* () {
        resetMocks();
        const gate = yield* Deferred.make<void>();
        generateThreadSummary.mockImplementation(() =>
          Deferred.await(gate).pipe(Effect.as({ summary: "Late digest" })),
        );
        const reactor = yield* ThreadSummaryReactor;
        const engine = yield* OrchestrationEngineService;
        const h = yield* seed("stale");
        yield* reactor.start();

        yield* h.requestSummary("cmd-summary-request-stale");
        yield* waitFor(Effect.sync(() => generateThreadSummary.mock.calls.length === 1));
        const pending = (yield* h.readThread)?.summaryGeneration;
        expect(pending).not.toBeNull();
        // Something else clears the marker while generation is still running.
        yield* engine.dispatch({
          type: "thread.summary.regeneration.complete",
          commandId: CommandId.make("cmd-summary-clear-stale"),
          threadId: ThreadId.make("thread-stale"),
          requestId: pending!.requestId,
        });
        yield* Deferred.succeed(gate, undefined);
        yield* reactor.drain;
        yield* settle;
        expect((yield* h.readThread)?.summary ?? null).toBeNull();
      }),
    ),
  );

  it.live("refreshes a running thread on the live interval", () =>
    run(
      Effect.gen(function* () {
        resetMocks();
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({ summaryAutoRefresh: "live" });
        yield* Effect.addFinalizer(() =>
          settings.updateSettings({ summaryAutoRefresh: "turn_end" }).pipe(Effect.orDie),
        );
        const reactor = yield* ThreadSummaryReactor;
        const engine = yield* OrchestrationEngineService;
        // Start first so the reactor sees the turn start that arms the timer.
        yield* reactor.start();
        const h = yield* seed("live");
        // A turn only counts as running once the session adopts it.
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-running-live"),
          threadId: ThreadId.make("thread-live"),
          session: {
            threadId: ThreadId.make("thread-live"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: TurnId.make("turn-live"),
            lastError: null,
            updatedAt: NOW,
          },
          createdAt: NOW,
        });
        yield* waitFor(
          h.readThread.pipe(Effect.map((thread) => thread?.summary?.text === "Thread digest")),
        );
        expect(generateThreadSummary).toHaveBeenCalledTimes(1);
      }),
      LiveTestLayer,
    ),
  );

  it.live("leaves turn end alone when automatic refresh is off but still honours requests", () =>
    run(
      Effect.gen(function* () {
        resetMocks();
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({ summaryAutoRefresh: "off" });
        yield* Effect.addFinalizer(() =>
          settings.updateSettings({ summaryAutoRefresh: "turn_end" }).pipe(Effect.orDie),
        );
        const reactor = yield* ThreadSummaryReactor;
        const h = yield* seed("auto-off");
        yield* reactor.start();

        yield* h.completeTurn("turn-1", "cmd-turn-diff-off");
        yield* reactor.drain;
        yield* settle;
        expect(generateThreadSummary).not.toHaveBeenCalled();

        yield* h.requestSummary("cmd-summary-request-manual");
        yield* waitFor(
          h.readThread.pipe(Effect.map((thread) => thread?.summary?.text === "Thread digest")),
        );
      }),
    ),
  );
});
