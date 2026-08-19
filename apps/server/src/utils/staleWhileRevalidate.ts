import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/**
 * Stale answers served while a fresh one is fetched behind them, for reads that leave the
 * process for a CLI whose wall clock is the host's — seconds on a good day, tens of them on a
 * slow network. The last success per key is held a while past its cache window: a read inside
 * the window answers with it at once and refreshes the cache in the background, so the next
 * read is fresh without anyone having waited on it.
 *
 * Correctness leans on the caller's epoch-keyed caches: an explicit refresh or a mutation bumps
 * the epochs, the epoch is part of every key, and a held answer under the old key is simply
 * never asked for again — so "give me truly fresh" still means exactly that.
 *
 * Shared by the pull-request and issue services, which hold their host reads to one posture.
 */
export const makeStaleWhileRevalidate = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  return <A>(staleFor: Duration.Duration, capacity: number) => {
    const staleMs = Duration.toMillis(staleFor);
    const held = new Map<string, { readonly at: number; readonly value: A }>();
    const record = (key: string, value: A) =>
      Effect.map(Clock.currentTimeMillis, (at) => {
        held.delete(key);
        if (held.size >= capacity) {
          const oldest = held.keys().next().value;
          if (oldest !== undefined) held.delete(oldest);
        }
        held.set(key, { at, value });
      });
    return <E>(key: string, read: Effect.Effect<A, E>): Effect.Effect<A, E> => {
      const recorded = read.pipe(Effect.tap((value) => record(key, value)));
      return Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const snapshot = held.get(key);
        if (snapshot === undefined || now - snapshot.at > staleMs) return recorded;
        // Run as its own fiber rather than a child: the caller is answered and gone before the
        // refresh lands. The read still coalesces on the cache key, so ten stale reads in one
        // window cost one host request — and a failed refresh costs nothing but the retry.
        return Effect.sync(() => runFork(Effect.ignore(recorded))).pipe(Effect.as(snapshot.value));
      });
    };
  };
});
