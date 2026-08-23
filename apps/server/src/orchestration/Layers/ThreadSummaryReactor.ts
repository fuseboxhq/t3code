/**
 * ThreadSummaryReactor - keeps thread and project summaries current.
 *
 * Mirrors the title-regeneration flow in ProviderCommandReactor: a pending
 * marker with a request id is stamped by the decider, this reactor generates
 * the text, re-reads the aggregate, and only completes when the request is
 * still the current one. Everything the model sees is built in
 * `summaryContext.ts`.
 *
 * Triggers:
 * - `thread.meta-updated` / `project.meta-updated` with `regenerateSummary`
 *   (on demand, or dispatched by the automatic policy below).
 * - `thread.turn-diff-completed`: turn end. Skipped when auto-refresh is off
 *   or the thread has nothing new since its summary.
 * - While a turn runs in "live" mode, a per-thread timer requests a refresh
 *   every few minutes.
 * - A finished thread summary schedules a debounced project rollup.
 */
import {
  CommandId,
  type OrchestrationEvent,
  type ProjectId,
  TextGenerationError,
  type ThreadId,
  type ThreadSummary,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveSummaryModelSelection } from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadSummaryReactor,
  type ThreadSummaryReactorShape,
} from "../Services/ThreadSummaryReactor.ts";
import {
  buildProjectSummaryContext,
  buildThreadSummaryContext,
  isThreadSummaryCurrent,
} from "../summaryContext.ts";

export interface ThreadSummaryReactorOptions {
  /** How often a running thread refreshes in "live" mode. */
  readonly liveRefreshInterval?: Duration.Duration;
  /** Quiet window before a project rollup after a thread summary lands. */
  readonly projectRollupDebounce?: Duration.Duration;
}

const DEFAULT_LIVE_REFRESH_INTERVAL = Duration.minutes(3);
const DEFAULT_PROJECT_ROLLUP_DEBOUNCE = Duration.seconds(30);
const GENERATION_TIMEOUT = Duration.minutes(5);

type SummaryJob =
  | { readonly kind: "thread"; readonly threadId: ThreadId; readonly requestId: CommandId }
  | { readonly kind: "project"; readonly projectId: ProjectId; readonly requestId: CommandId };

export const make = (options: ThreadSummaryReactorOptions = {}) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const textGeneration = yield* TextGeneration;
    const serverSettingsService = yield* ServerSettingsService;
    const liveRefreshInterval = options.liveRefreshInterval ?? DEFAULT_LIVE_REFRESH_INTERVAL;
    const projectRollupDebounce = options.projectRollupDebounce ?? DEFAULT_PROJECT_ROLLUP_DEBOUNCE;

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const serverCommandId = (tag: string) =>
      crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

    const resolveThread = (threadId: ThreadId) =>
      projectionSnapshotQuery.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined));
    const resolveProject = (projectId: ProjectId) =>
      projectionSnapshotQuery
        .getProjectShellById(projectId)
        .pipe(Effect.map(Option.getOrUndefined));

    // Failures are logged and swallowed: a summary that did not generate must
    // never take the reactor down. Interrupts propagate so shutdown stays clean.
    const logWarning =
      (message: string, fields: Record<string, unknown>) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
        effect.pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning(message, { ...fields, cause: Cause.pretty(cause) }),
          ),
        );

    // Jobs run one at a time, so a provider that never answers would stall
    // every later summary. Cap each call; the failure path clears the marker.
    const bounded = <A, R>(
      operation: "generateThreadSummary" | "generateProjectSummary",
      effect: Effect.Effect<A, TextGenerationError, R>,
    ): Effect.Effect<A, TextGenerationError, R> =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: GENERATION_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Summary generation timed out." }),
            ),
        }),
      );

    // ── Dispatch helpers ─────────────────────────────────────────────

    const requestThreadSummary = (threadId: ThreadId) =>
      serverCommandId("thread-summary-request").pipe(
        Effect.flatMap((commandId) =>
          orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId,
            threadId,
            regenerateSummary: true,
          }),
        ),
        Effect.asVoid,
      );

    const requestProjectSummary = (projectId: ProjectId) =>
      serverCommandId("project-summary-request").pipe(
        Effect.flatMap((commandId) =>
          orchestrationEngine.dispatch({
            type: "project.meta.update",
            commandId,
            projectId,
            regenerateSummary: true,
          }),
        ),
        Effect.asVoid,
      );

    const completeThreadSummary = (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly summary?: ThreadSummary;
    }) =>
      serverCommandId("thread-summary-complete").pipe(
        Effect.flatMap((commandId) =>
          orchestrationEngine.dispatch({
            type: "thread.summary.regeneration.complete",
            commandId,
            threadId: input.threadId,
            requestId: input.requestId,
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
          }),
        ),
        Effect.asVoid,
      );

    const completeProjectSummary = (input: {
      readonly projectId: ProjectId;
      readonly requestId: CommandId;
      readonly summary?: { readonly text: string; readonly generatedAt: string };
    }) =>
      serverCommandId("project-summary-complete").pipe(
        Effect.flatMap((commandId) =>
          orchestrationEngine.dispatch({
            type: "project.summary.regeneration.complete",
            commandId,
            projectId: input.projectId,
            requestId: input.requestId,
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
          }),
        ),
        Effect.asVoid,
      );

    // ── Project rollup debounce ──────────────────────────────────────

    const pendingProjectRollups = new Set<ProjectId>();

    const scheduleProjectRollup = (projectId: ProjectId, scope: Scope.Scope) =>
      Effect.gen(function* () {
        // A pending timer already covers this window; the rollup reads the
        // latest thread summaries when it fires, so nothing is lost. The set
        // entry is claimed before the fork so concurrent callers cannot both
        // schedule one.
        if (pendingProjectRollups.has(projectId)) return;
        pendingProjectRollups.add(projectId);
        yield* Effect.sleep(projectRollupDebounce).pipe(
          Effect.andThen(requestProjectSummary(projectId)),
          logWarning("summary reactor failed to request project rollup", { projectId }),
          Effect.ensuring(Effect.sync(() => pendingProjectRollups.delete(projectId))),
          Effect.forkIn(scope),
        );
      });

    // ── Live refresh timers ──────────────────────────────────────────

    const liveTimers = new Map<ThreadId, Fiber.Fiber<unknown>>();

    const stopLiveTimer = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const fiber = liveTimers.get(threadId);
        if (!fiber) return;
        liveTimers.delete(threadId);
        yield* Fiber.interrupt(fiber);
      });

    const liveRefreshTick = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const settings = yield* serverSettingsService.getSettings;
        if (settings.summaryAutoRefresh !== "live") return;
        const thread = yield* resolveThread(threadId);
        if (!thread || thread.latestTurn?.state !== "running") return;
        if (thread.summaryGeneration != null || isThreadSummaryCurrent(thread)) return;
        yield* requestThreadSummary(threadId);
      }).pipe(logWarning("summary reactor live refresh failed", { threadId }));

    const startLiveTimer = (threadId: ThreadId, scope: Scope.Scope) =>
      Effect.gen(function* () {
        const settings = yield* serverSettingsService.getSettings;
        if (settings.summaryAutoRefresh !== "live") return;
        yield* stopLiveTimer(threadId);
        const fiber = yield* Effect.sleep(liveRefreshInterval).pipe(
          Effect.andThen(liveRefreshTick(threadId)),
          Effect.forever,
          Effect.forkIn(scope),
        );
        liveTimers.set(threadId, fiber);
      });

    // ── Generation ───────────────────────────────────────────────────

    // The thread may have moved on while the model was working. If its turn
    // has since ended, the turn-end refresh was skipped because a request was
    // pending, so queue the follow-up here. A still-running turn is left to
    // the live timer, and callers skip this after an empty result, so it
    // cannot loop.
    const requestFollowUpIfStale = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const after = yield* resolveThread(threadId);
        if (after && after.latestTurn?.state !== "running" && !isThreadSummaryCurrent(after)) {
          yield* requestThreadSummary(threadId);
        }
      });

    const generateThreadSummary = (job: Extract<SummaryJob, { kind: "thread" }>) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(job.threadId);
        if (!thread || thread.summaryGeneration?.requestId !== job.requestId) return;

        // Automatic triggers only request when something changed, so an empty
        // delta means a person asked for a regenerate with nothing new: give
        // them a fresh rewrite of the whole thread instead of a silent no-op.
        const incremental = buildThreadSummaryContext(thread);
        const built = incremental.hasContent
          ? incremental
          : buildThreadSummaryContext({ ...thread, summary: null });
        if (!built.hasContent) {
          yield* completeThreadSummary({ threadId: job.threadId, requestId: job.requestId });
          return;
        }

        const project = yield* resolveProject(thread.projectId);
        const cwd =
          resolveThreadWorkspaceCwd({ thread, projects: project ? [project] : [] }) ??
          process.cwd();
        const settings = yield* serverSettingsService.getSettings;
        const generated = yield* bounded(
          "generateThreadSummary",
          textGeneration.generateThreadSummary({
            cwd,
            context: built.context,
            previousSummary: built.previousSummary,
            modelSelection: resolveSummaryModelSelection(settings),
          }),
        );

        const latest = yield* resolveThread(job.threadId);
        if (!latest || latest.summaryGeneration?.requestId !== job.requestId) return;
        const generatedAt = yield* nowIso;
        yield* completeThreadSummary({
          threadId: job.threadId,
          requestId: job.requestId,
          ...(generated.summary.length > 0
            ? { summary: { text: generated.summary, generatedAt, basis: built.basis } }
            : {}),
        });
        if (generated.summary.length > 0 && settings.summaryAutoRefresh !== "off") {
          yield* requestFollowUpIfStale(job.threadId);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("summary reactor failed to generate thread summary", {
                threadId: job.threadId,
                cause: Cause.pretty(cause),
              }).pipe(
                // Clear the pending marker so the UI does not spin forever.
                Effect.andThen(
                  completeThreadSummary({ threadId: job.threadId, requestId: job.requestId }),
                ),
                logWarning("summary reactor failed to clear thread summary marker", {
                  threadId: job.threadId,
                }),
              ),
        ),
      );

    const generateProjectSummary = (job: Extract<SummaryJob, { kind: "project" }>) =>
      Effect.gen(function* () {
        const project = yield* resolveProject(job.projectId);
        if (!project || project.summaryGeneration?.requestId !== job.requestId) return;

        const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
        const built = buildProjectSummaryContext({
          project,
          threads: readModel.threads.filter((thread) => thread.projectId === job.projectId),
        });
        if (!built.hasContent) {
          yield* completeProjectSummary({ projectId: job.projectId, requestId: job.requestId });
          return;
        }

        const settings = yield* serverSettingsService.getSettings;
        const generated = yield* bounded(
          "generateProjectSummary",
          textGeneration.generateProjectSummary({
            cwd: project.workspaceRoot,
            projectTitle: project.title,
            context: built.context,
            modelSelection: resolveSummaryModelSelection(settings),
          }),
        );

        const latest = yield* resolveProject(job.projectId);
        if (!latest || latest.summaryGeneration?.requestId !== job.requestId) return;
        const generatedAt = yield* nowIso;
        yield* completeProjectSummary({
          projectId: job.projectId,
          requestId: job.requestId,
          ...(generated.summary.length > 0
            ? { summary: { text: generated.summary, generatedAt } }
            : {}),
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("summary reactor failed to generate project summary", {
                projectId: job.projectId,
                cause: Cause.pretty(cause),
              }).pipe(
                Effect.andThen(
                  completeProjectSummary({ projectId: job.projectId, requestId: job.requestId }),
                ),
                logWarning("summary reactor failed to clear project summary marker", {
                  projectId: job.projectId,
                }),
              ),
        ),
      );

    const worker = yield* makeDrainableWorker((job: SummaryJob) =>
      job.kind === "thread" ? generateThreadSummary(job) : generateProjectSummary(job),
    );

    // ── Event routing ────────────────────────────────────────────────

    const onTurnEnd = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const settings = yield* serverSettingsService.getSettings;
        if (settings.summaryAutoRefresh === "off") return;
        const thread = yield* resolveThread(threadId);
        if (!thread || thread.summaryGeneration != null || isThreadSummaryCurrent(thread)) return;
        yield* requestThreadSummary(threadId);
      }).pipe(logWarning("summary reactor turn-end refresh failed", { threadId }));

    const onThreadMetaUpdated = (
      event: Extract<OrchestrationEvent, { type: "thread.meta-updated" }>,
      scope: Scope.Scope,
    ) =>
      Effect.gen(function* () {
        const pending = event.payload.summaryGeneration;
        if (event.payload.regenerateSummary === true && pending) {
          yield* worker.enqueue({
            kind: "thread",
            threadId: event.payload.threadId,
            requestId: pending.requestId,
          });
          return;
        }
        // A completed summary (pending cleared with text) feeds the rollup.
        if (event.payload.summary && event.payload.summaryGeneration === null) {
          const thread = yield* resolveThread(event.payload.threadId);
          if (thread) yield* scheduleProjectRollup(thread.projectId, scope);
        }
      });

    const onProjectMetaUpdated = (
      event: Extract<OrchestrationEvent, { type: "project.meta-updated" }>,
    ) => {
      const pending = event.payload.summaryGeneration;
      return event.payload.regenerateSummary === true && pending
        ? worker.enqueue({
            kind: "project",
            projectId: event.payload.projectId,
            requestId: pending.requestId,
          })
        : Effect.void;
    };

    const processEvent = (event: OrchestrationEvent, scope: Scope.Scope) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "thread.meta-updated":
            return yield* onThreadMetaUpdated(event, scope);
          case "project.meta-updated":
            return yield* onProjectMetaUpdated(event);
          case "thread.turn-start-requested":
            return yield* startLiveTimer(event.payload.threadId, scope);
          case "thread.turn-diff-completed":
            yield* stopLiveTimer(event.payload.threadId);
            return yield* onTurnEnd(event.payload.threadId);
          case "thread.turn-interrupt-requested":
          case "thread.session-stop-requested":
          case "thread.deleted":
            return yield* stopLiveTimer(event.payload.threadId);
          default:
            return;
        }
      }).pipe(logWarning("summary reactor failed to process event", { eventType: event.type }));

    // ── Startup ──────────────────────────────────────────────────────

    // The domain event stream is hot, so requests pending before this reactor
    // started cannot be resumed. Clear their markers; completions are keyed by
    // request id so a newer request is never touched.
    const clearInterrupted = Effect.gen(function* () {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      for (const thread of readModel.threads) {
        const requestId = thread.summaryGeneration?.requestId;
        if (requestId !== undefined) {
          yield* completeThreadSummary({ threadId: thread.id, requestId });
        }
      }
      for (const project of readModel.projects) {
        const requestId = project.summaryGeneration?.requestId;
        if (requestId !== undefined) {
          yield* completeProjectSummary({ projectId: project.id, requestId });
        }
      }
    }).pipe(logWarning("summary reactor failed to clear interrupted generations", {}));

    const start: ThreadSummaryReactorShape["start"] = Effect.fn("start")(function* () {
      const scope = yield* Effect.scope;
      // The domain stream is hot, so the subscription must be live before
      // start resolves or the first events after boot are lost. The consumer
      // completes `subscribed` once the stream has handed it control.
      const subscribed = yield* Deferred.make<void>();
      yield* forkParked(
        Stream.runForEach(
          orchestrationEngine.streamDomainEvents.pipe(
            Stream.onStart(Deferred.succeed(subscribed, undefined)),
          ),
          (event) => processEvent(event, scope),
        ),
      );
      yield* forkParked(clearInterrupted);
      if ((yield* ServerActivation) === undefined) {
        yield* Deferred.await(subscribed);
      }
    });

    return { start, drain: worker.drain } satisfies ThreadSummaryReactorShape;
  });

export const ThreadSummaryReactorLive = Layer.effect(ThreadSummaryReactor, make());
