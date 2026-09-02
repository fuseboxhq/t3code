import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import addProjectionSummaries from "./041_ProjectionSummaries.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = Effect.fn("columnNames")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(${sql.literal(table)})
  `;
  return new Set(columns.map((column) => column.name));
});

layer("044_ForkSchemaCompatibility", (it) => {
  it.effect("repairs a fork database that recorded ProjectionSummaries as migration 41", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* addProjectionSummaries;
      yield* sql`ALTER TABLE auth_sessions DROP COLUMN client_surface`;
      yield* sql`ALTER TABLE auth_sessions DROP COLUMN client_app_version`;
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = 'ProjectionSummaries'
        WHERE migration_id = 41
      `;

      yield* runMigrations();

      const authColumns = yield* columnNames("auth_sessions");
      const threadColumns = yield* columnNames("projection_threads");
      const projectColumns = yield* columnNames("projection_projects");
      const migrations = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 41
        ORDER BY migration_id
      `;

      assert.ok(authColumns.has("client_surface"));
      assert.ok(authColumns.has("client_app_version"));
      assert.ok(threadColumns.has("linked_pull_request_json"));
      assert.ok(threadColumns.has("unsettled_at"));
      assert.ok(threadColumns.has("parent_thread_id"));
      assert.ok(threadColumns.has("summary_text"));
      assert.ok(projectColumns.has("summary_text"));
      assert.deepStrictEqual(migrations, [
        { migration_id: 41, name: "ProjectionSummaries" },
        { migration_id: 42, name: "ProjectionThreadLinkedPullRequest" },
        { migration_id: 43, name: "ProjectionThreadsUnsettledAt" },
        { migration_id: 44, name: "ForkSchemaCompatibility" },
        { migration_id: 45, name: "ProjectionThreadsParent" },
      ]);
    }),
  );
});
