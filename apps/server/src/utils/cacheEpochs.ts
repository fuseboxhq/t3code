/** What a per-reference epoch is scoped by: one host object inside one project. */
export interface CacheEpochRef {
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
}

export interface CacheEpochs {
  /** The listings' current epoch, part of every listing cache key. */
  readonly listingsEpoch: () => number;
  /** Strand every listing entry made under the old epoch. */
  readonly bumpListingsEpoch: () => void;
  /** One reference's current epoch, part of its detail-shaped cache keys. */
  readonly refEpoch: (ref: CacheEpochRef) => number;
  /** Strand every entry the reference's old epoch keyed. */
  readonly bumpRefEpoch: (ref: CacheEpochRef) => void;
}

/**
 * Epochs are the cache-invalidation mechanism shared by the pull-request and issue services: a
 * key carries its scope's epoch, so bumping the epoch strands every entry made under the old
 * one — no enumerating a cache whose keys (cursors, filters) nothing holds a list of. The
 * counter is shared and monotonic so a scope re-entering after eviction can never mint a key an
 * old entry still has.
 *
 * Every scope absent from the map reads the floor. Evicting a scope raises it past the evicted
 * epoch, so the scope can never fall back onto an epoch a live cache entry still holds —
 * dropping to a plain 0 would resurrect entries keyed before its mutations.
 */
export function makeCacheEpochs(capacity = 2_048): CacheEpochs {
  let counter = 0;
  let listings = 0;
  let floor = 0;
  const refEpochs = new Map<string, number>();
  const scopeOf = (ref: CacheEpochRef) => `${ref.projectId} ${ref.repository} ${ref.number}`;
  return {
    listingsEpoch: () => listings,
    bumpListingsEpoch: () => {
      listings = ++counter;
    },
    refEpoch: (ref) => refEpochs.get(scopeOf(ref)) ?? floor,
    bumpRefEpoch: (ref) => {
      const scope = scopeOf(ref);
      if (!refEpochs.has(scope) && refEpochs.size >= capacity) {
        const oldest = refEpochs.keys().next().value;
        if (oldest !== undefined) {
          refEpochs.delete(oldest);
          floor = ++counter;
        }
      }
      refEpochs.set(scope, ++counter);
    },
  };
}
