import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import addProjectionSummaries from "./041_ProjectionSummaries.ts";
import addProjectionThreadsParent from "./049_ProjectionThreadsParent.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = Effect.fn("columnNames")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(${sql.literal(table)})
  `;
  return new Set(columns.map((column) => column.name));
});

layer("048_ForkSchemaCompatibility", (it) => {
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
        { migration_id: 44, name: "ClearAutomaticProjectModelDefaults" },
        { migration_id: 45, name: "ProjectionProjectsAutoPull" },
        { migration_id: 46, name: "RepairAutomaticSettlementTimestamps" },
        { migration_id: 47, name: "ProjectionProjectIcon" },
        { migration_id: 48, name: "ForkSchemaCompatibility" },
        { migration_id: 49, name: "ProjectionThreadsParent" },
      ]);
    }),
  );
});

const collisionLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

collisionLayer("048_ForkSchemaCompatibility migration ID collisions", (it) => {
  it.effect("replays upstream migrations whose IDs were already used by the fork", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* addProjectionSummaries;
      yield* addProjectionThreadsParent;
      yield* sql`ALTER TABLE projection_projects DROP COLUMN auto_pull`;
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = CASE migration_id
          WHEN 44 THEN 'ForkSchemaCompatibility'
          WHEN 45 THEN 'ProjectionThreadsParent'
        END
        WHERE migration_id IN (44, 45)
      `;
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-auto',
          'Automatic default',
          '/tmp/automatic-default',
          '{"instanceId":"codex","model":"gpt-5.6-sol"}',
          '[]',
          '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'event-project-auto',
          'project',
          'project-auto',
          0,
          'project.created',
          '2026-08-01T00:00:00.000Z',
          'command-project-auto',
          NULL,
          'command-project-auto',
          'client',
          '{"defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"}}',
          '{}'
        )
      `;

      const executed = yield* runMigrations();

      const projectColumns = yield* columnNames("projection_projects");
      const projects = yield* sql<{ readonly selection: string | null }>`
        SELECT default_model_selection_json AS "selection"
        FROM projection_projects
        WHERE project_id = 'project-auto'
      `;
      const events = yield* sql<{ readonly model: string | null }>`
        SELECT json_extract(payload_json, '$.defaultModelSelection.model') AS "model"
        FROM orchestration_events
        WHERE event_id = 'event-project-auto'
      `;

      assert.deepStrictEqual(executed, [
        [46, "RepairAutomaticSettlementTimestamps"],
        [47, "ProjectionProjectIcon"],
        [48, "ForkSchemaCompatibility"],
        [49, "ProjectionThreadsParent"],
      ]);
      assert.ok(projectColumns.has("auto_pull"));
      assert.deepStrictEqual(projects, [{ selection: null }]);
      assert.deepStrictEqual(events, [{ model: null }]);
    }),
  );
});
