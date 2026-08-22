/**
 * ThreadSummaryReactor - Summary generation reactor interface.
 *
 * Owns the background workers that keep thread and project summaries fresh:
 * on-demand regeneration requests, turn-end refreshes, periodic refreshes
 * while a turn runs, and the per-project rollup.
 *
 * @module ThreadSummaryReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ThreadSummaryReactorShape {
  /** Start the reactor; run inside a scope so workers finalize on shutdown. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves when every queued summary job has finished. Test hook. */
  readonly drain: Effect.Effect<void>;
}

export class ThreadSummaryReactor extends Context.Service<
  ThreadSummaryReactor,
  ThreadSummaryReactorShape
>()("t3/orchestration/Services/ThreadSummaryReactor") {}
