import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";
const PENDING_REQUEST = CommandId.make("cmd-summary-pending");

function makeReadModel(input: {
  readonly threadPending?: boolean;
  readonly projectPending?: boolean;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: null,
        scripts: [],
        ...(input.projectPending
          ? { summaryGeneration: { requestId: PENDING_REQUEST, startedAt: UPDATED_AT } }
          : {}),
        createdAt: UPDATED_AT,
        updatedAt: UPDATED_AT,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-luna" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: UPDATED_AT,
        updatedAt: UPDATED_AT,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        ...(input.threadPending
          ? { summaryGeneration: { requestId: PENDING_REQUEST, startedAt: UPDATED_AT } }
          : {}),
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: UPDATED_AT,
  };
}

const firstEvent = (result: unknown) => (Array.isArray(result) ? result[0] : result);

it.layer(NodeServices.layer)("summary regeneration decider", (it) => {
  it.effect("stamps a pending marker keyed by the requesting command", () =>
    Effect.gen(function* () {
      const event = firstEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-summary-request"),
            threadId: ThreadId.make("thread-1"),
            regenerateSummary: true,
          },
          readModel: makeReadModel({}),
        }),
      );
      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload.regenerateSummary).toBe(true);
        expect(event.payload.summaryGeneration?.requestId).toBe("cmd-summary-request");
      }
    }),
  );

  it.effect("ignores a second request while one is pending", () =>
    Effect.gen(function* () {
      const event = firstEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-summary-request-2"),
            threadId: ThreadId.make("thread-1"),
            regenerateSummary: true,
          },
          readModel: makeReadModel({ threadPending: true }),
        }),
      );
      if (event.type === "thread.meta-updated") {
        expect(event.payload.regenerateSummary).toBeUndefined();
        expect(event.payload.summaryGeneration).toBeUndefined();
      }
    }),
  );

  it.effect("applies a matching completion and clears the marker", () =>
    Effect.gen(function* () {
      const summary = {
        text: "Investigating reconnect failures; fix drafted in relay.ts.",
        generatedAt: UPDATED_AT,
        basis: { messageCount: 4, turnId: null },
      };
      const event = firstEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.summary.regeneration.complete",
            commandId: CommandId.make("cmd-summary-complete"),
            threadId: ThreadId.make("thread-1"),
            requestId: PENDING_REQUEST,
            summary,
          },
          readModel: makeReadModel({ threadPending: true }),
        }),
      );
      if (event.type === "thread.meta-updated") {
        expect(event.payload.summary).toEqual(summary);
        expect(event.payload.summaryGeneration).toBeNull();
      }
    }),
  );

  it.effect("drops a stale thread completion without touching updatedAt", () =>
    Effect.gen(function* () {
      const event = firstEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.summary.regeneration.complete",
            commandId: CommandId.make("cmd-summary-complete-stale"),
            threadId: ThreadId.make("thread-1"),
            requestId: CommandId.make("cmd-old-request"),
            summary: {
              text: "stale",
              generatedAt: UPDATED_AT,
              basis: { messageCount: 1, turnId: null },
            },
          },
          readModel: makeReadModel({ threadPending: true }),
        }),
      );
      if (event.type === "thread.meta-updated") {
        expect(event.payload).toEqual({
          threadId: ThreadId.make("thread-1"),
          updatedAt: UPDATED_AT,
        });
      }
    }),
  );

  it.effect("mirrors the flow for projects", () =>
    Effect.gen(function* () {
      const request = firstEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-project-summary-request"),
            projectId: ProjectId.make("project-1"),
            regenerateSummary: true,
          },
          readModel: makeReadModel({}),
        }),
      );
      if (request.type === "project.meta-updated") {
        expect(request.payload.summaryGeneration?.requestId).toBe("cmd-project-summary-request");
      }
      const stale = firstEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.summary.regeneration.complete",
            commandId: CommandId.make("cmd-project-summary-complete"),
            projectId: ProjectId.make("project-1"),
            requestId: CommandId.make("cmd-other"),
            summary: { text: "stale", generatedAt: UPDATED_AT },
          },
          readModel: makeReadModel({ projectPending: true }),
        }),
      );
      if (stale.type === "project.meta-updated") {
        expect(stale.payload.summary).toBeUndefined();
        expect(stale.payload.updatedAt).toBe(UPDATED_AT);
      }
    }),
  );
});
