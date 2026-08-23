import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Thread and project summaries plus their pending-generation markers. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const hasThreadColumn = (name: string) => threadColumns.some((column) => column.name === name);
  if (!hasThreadColumn("summary_text")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN summary_text TEXT`;
  }
  if (!hasThreadColumn("summary_generated_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN summary_generated_at TEXT`;
  }
  if (!hasThreadColumn("summary_basis_message_count")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN summary_basis_message_count INTEGER`;
  }
  if (!hasThreadColumn("summary_basis_turn_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN summary_basis_turn_id TEXT`;
  }
  if (!hasThreadColumn("summary_basis_activity_count")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN summary_basis_activity_count INTEGER`;
  }
  if (!hasThreadColumn("summary_basis_last_message_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN summary_basis_last_message_at TEXT`;
  }
  if (!hasThreadColumn("summary_generation_request_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN summary_generation_request_id TEXT`;
  }
  if (!hasThreadColumn("summary_generation_started_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN summary_generation_started_at TEXT`;
  }

  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  const hasProjectColumn = (name: string) => projectColumns.some((column) => column.name === name);
  if (!hasProjectColumn("summary_text")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN summary_text TEXT`;
  }
  if (!hasProjectColumn("summary_generated_at")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN summary_generated_at TEXT`;
  }
  if (!hasProjectColumn("summary_generation_request_id")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN summary_generation_request_id TEXT`;
  }
  if (!hasProjectColumn("summary_generation_started_at")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN summary_generation_started_at TEXT`;
  }
});
