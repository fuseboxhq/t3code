import * as Effect from "effect/Effect";

import addAuthSessionClientConnection from "./041_AuthSessionClientConnection.ts";
import addProjectionSummaries from "./041_ProjectionSummaries.ts";

/**
 * Reconcile the fork's historical migration 41 with upstream migration 41.
 *
 * Existing fork databases recorded migration 41 as ProjectionSummaries, while
 * upstream assigned the same ID to AuthSessionClientConnection. Both changes
 * are idempotent, so this bridge applies both schemas after upstream 41-43.
 */
export default Effect.gen(function* () {
  yield* addAuthSessionClientConnection;
  yield* addProjectionSummaries;
});
