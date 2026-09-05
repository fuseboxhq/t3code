import * as Effect from "effect/Effect";

import addAuthSessionClientConnection from "./041_AuthSessionClientConnection.ts";
import addProjectionSummaries from "./041_ProjectionSummaries.ts";
import clearAutomaticProjectModelDefaults from "./044_ClearAutomaticProjectModelDefaults.ts";
import addProjectionProjectsAutoPull from "./045_ProjectionProjectsAutoPull.ts";

/**
 * Reconcile migration IDs used by existing fork databases with upstream.
 *
 * Existing fork databases recorded migration 41 as ProjectionSummaries, while
 * upstream assigned that ID to AuthSessionClientConnection. The fork also used
 * IDs 44 and 45 before upstream assigned its own migrations to them. These
 * operations are idempotent, so this bridge applies every skipped change.
 */
export default Effect.gen(function* () {
  yield* addAuthSessionClientConnection;
  yield* addProjectionSummaries;
  yield* clearAutomaticProjectModelDefaults;
  yield* addProjectionProjectsAutoPull;
});
