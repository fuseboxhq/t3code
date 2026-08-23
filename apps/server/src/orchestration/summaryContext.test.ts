import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThread } from "@t3tools/contracts";
import { CheckpointRef, EventId, MessageId, TurnId } from "@t3tools/contracts";

import {
  buildProjectSummaryContext,
  buildThreadSummaryContext,
  isThreadSummaryCurrent,
} from "./summaryContext.ts";

type Thread = Pick<
  OrchestrationThread,
  "messages" | "activities" | "checkpoints" | "latestTurn" | "summary"
>;

function message(index: number, role: "user" | "assistant", text: string) {
  return {
    id: MessageId.make(`message-${index}`),
    role,
    text,
    attachments: [],
    turnId: null,
    createdAt: `2026-01-01T00:00:0${index}.000Z`,
    updatedAt: `2026-01-01T00:00:0${index}.000Z`,
  } as unknown as OrchestrationThread["messages"][number];
}

function activity(index: number, tone: "tool" | "info", summary: string, createdAt: string) {
  return {
    id: EventId.make(`activity-${index}`),
    tone,
    kind: "tool.call",
    summary,
    payload: null,
    turnId: null,
    createdAt,
  } as OrchestrationThread["activities"][number];
}

const baseThread: Thread = {
  messages: [
    message(1, "user", "Fix the reconnect bug"),
    message(2, "assistant", "Found it in relay.ts; patching."),
  ],
  activities: [activity(1, "tool", "Edited relay.ts", "2026-01-01T00:00:01.500Z")],
  checkpoints: [],
  latestTurn: {
    turnId: TurnId.make("turn-1"),
    state: "completed",
    requestedAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    assistantMessageId: null,
  },
  summary: null,
};

describe("buildThreadSummaryContext", () => {
  it("uses the whole thread and no previous summary on first generation", () => {
    const built = buildThreadSummaryContext(baseThread);
    expect(built.previousSummary).toBeUndefined();
    expect(built.context).toContain("USER:\nFix the reconnect bug");
    expect(built.context).toContain("- [tool] Edited relay.ts");
    expect(built.basis).toEqual({
      messageCount: 2,
      turnId: "turn-1",
      activityCount: 1,
      lastMessageAt: "2026-01-01T00:00:02.000Z",
    });
    expect(built.hasContent).toBe(true);
  });

  it("feeds only the delta since the previous summary's basis", () => {
    const thread: Thread = {
      ...baseThread,
      messages: [...baseThread.messages, message(3, "user", "Now add a test")],
      activities: [
        ...baseThread.activities,
        activity(2, "tool", "Created relay.test.ts", "2026-01-01T00:00:05.000Z"),
      ],
      summary: {
        text: "Reconnect bug located in relay.ts.",
        generatedAt: "2026-01-01T00:00:03.000Z",
        basis: { messageCount: 2, turnId: TurnId.make("turn-1") },
      },
    };
    const built = buildThreadSummaryContext(thread);
    expect(built.previousSummary).toBe("Reconnect bug located in relay.ts.");
    expect(built.context).toContain("Now add a test");
    expect(built.context).not.toContain("Fix the reconnect bug");
    expect(built.context).toContain("Created relay.test.ts");
    expect(built.context).not.toContain("Edited relay.ts");
    expect(built.basis.messageCount).toBe(3);
  });

  it("falls back to a full rebuild after a revert shrinks the thread", () => {
    const thread: Thread = {
      ...baseThread,
      summary: {
        text: "Stale",
        generatedAt: "2026-01-01T00:00:09.000Z",
        basis: { messageCount: 5, turnId: null },
      },
    };
    const built = buildThreadSummaryContext(thread);
    expect(built.previousSummary).toBeUndefined();
    expect(built.context).toContain("Fix the reconnect bug");
  });

  it("treats a streamed message edit or new activity as fresh content", () => {
    const summary = {
      text: "Done",
      generatedAt: "2026-01-01T00:00:03.000Z",
      basis: {
        messageCount: 2,
        turnId: TurnId.make("turn-1"),
        activityCount: 1,
        lastMessageAt: "2026-01-01T00:00:02.000Z",
      },
    };
    const streamed = {
      ...baseThread,
      summary,
      messages: [
        baseThread.messages[0]!,
        {
          ...baseThread.messages[1]!,
          text: "Found it in relay.ts; patched and added a test.",
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
      ],
    };
    expect(isThreadSummaryCurrent(streamed)).toBe(false);
    const built = buildThreadSummaryContext(streamed);
    expect(built.previousSummary).toBe("Done");
    expect(built.context).toContain("patched and added a test");

    const withActivity = {
      ...baseThread,
      summary,
      activities: [
        ...baseThread.activities,
        activity(2, "tool", "Ran tests", "2026-01-01T00:00:05.000Z"),
      ],
    };
    expect(isThreadSummaryCurrent(withActivity)).toBe(false);
  });

  it("counts checkpoint-only changes as content", () => {
    const built = buildThreadSummaryContext({
      ...baseThread,
      messages: [],
      activities: [],
      checkpoints: [
        {
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("ref-1"),
          status: "ready",
          files: [{ path: "relay.ts", kind: "modified", additions: 3, deletions: 1 }],
          assistantMessageId: null,
          completedAt: "2026-01-01T00:00:06.000Z",
        },
      ],
    });
    expect(built.hasContent).toBe(true);
    expect(built.context).toContain("relay.ts (modified, +3/-1)");
  });

  it("reports no content when nothing landed since the summary", () => {
    const thread: Thread = {
      ...baseThread,
      summary: {
        text: "Done",
        generatedAt: "2026-01-01T00:00:09.000Z",
        basis: {
          messageCount: 2,
          turnId: TurnId.make("turn-1"),
          activityCount: 1,
          lastMessageAt: "2026-01-01T00:00:02.000Z",
        },
      },
    };
    expect(buildThreadSummaryContext(thread).hasContent).toBe(false);
    expect(isThreadSummaryCurrent(thread)).toBe(true);
    expect(isThreadSummaryCurrent(baseThread)).toBe(false);
  });
});

describe("buildProjectSummaryContext", () => {
  it("lists active threads newest first and skips archived ones", () => {
    const built = buildProjectSummaryContext({
      project: { title: "T3" },
      threads: [
        {
          title: "Old",
          branch: null,
          latestTurn: null,
          summary: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
        },
        {
          title: "Archived",
          branch: null,
          latestTurn: null,
          summary: { text: "gone", generatedAt: "x", basis: { messageCount: 0, turnId: null } },
          updatedAt: "2026-01-03T00:00:00.000Z",
          archivedAt: "2026-01-03T00:00:00.000Z",
          deletedAt: null,
        },
        {
          title: "New",
          branch: "feat/x",
          latestTurn: null,
          summary: { text: "Shipping", generatedAt: "x", basis: { messageCount: 0, turnId: null } },
          updatedAt: "2026-01-02T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
        },
      ],
    });
    expect(built.hasContent).toBe(true);
    expect(built.context.indexOf("## New")).toBeLessThan(built.context.indexOf("## Old"));
    expect(built.context).not.toContain("Archived");
    expect(built.context).toContain("Branch: feat/x");
    expect(built.context).toContain("Summary: (none yet)");
  });
});
