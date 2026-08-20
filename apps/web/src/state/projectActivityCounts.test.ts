import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MergedIssueList } from "../components/leads/leadsList.logic";
import type { MergedPullRequestList } from "../components/pullRequest/pullRequestList.logic";
import type { AssignableProject } from "../components/pullRequest/pullRequestProjectAssignment.logic";
import {
  buildActivityTargets,
  deriveProjectActivity,
  sumProjectActivity,
} from "./projectActivityCounts";

function project(id: string, environmentId: string, canonicalKey?: string): AssignableProject {
  return {
    id: id as ProjectId,
    environmentId: environmentId as EnvironmentId,
    repositoryIdentity: canonicalKey === undefined ? null : { canonicalKey },
  };
}

const env = (id: string) => id as EnvironmentId;

function pullRequestRow(input: {
  environmentId: string;
  projectId: string;
  repository?: string;
  host?: string;
}) {
  return {
    environmentId: input.environmentId,
    projectId: input.projectId,
    host: input.host ?? "github.com",
    repository: input.repository ?? "fusebox/t3code",
  };
}

function mergedPullRequests(input: {
  entries: ReadonlyArray<ReturnType<typeof pullRequestRow>>;
  truncatedEnvironments?: ReadonlyArray<string>;
  nextCursors?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}): MergedPullRequestList {
  return {
    viewers: {},
    providers: [],
    entries: input.entries as unknown as MergedPullRequestList["entries"],
    errors: [],
    truncated: (input.truncatedEnvironments?.length ?? 0) > 0,
    nextCursors: input.nextCursors ?? {},
    truncatedEnvironments: input.truncatedEnvironments ?? [],
  };
}

function mergedLeads(input: {
  entries: ReadonlyArray<{ environmentId: string; projectId: string }>;
  truncatedEnvironments?: ReadonlyArray<string>;
}): MergedIssueList {
  return {
    providers: [],
    entries: input.entries as unknown as MergedIssueList["entries"],
    errors: [],
    truncated: (input.truncatedEnvironments?.length ?? 0) > 0,
    nextCursors: {},
    truncatedEnvironments: input.truncatedEnvironments ?? [],
  };
}

describe("buildActivityTargets", () => {
  const input = { state: "open", limit: 99 } as const;

  it("asks one server per shared repository and skips projectIds when a server lists all it holds", () => {
    const targets = buildActivityTargets(
      [env("e1"), env("e2")],
      [
        project("p1", "e1", "github.com/fusebox/t3code"),
        project("p2", "e2", "github.com/fusebox/t3code"),
        project("p3", "e2", "github.com/fusebox/kevfiles"),
      ],
      true,
      input,
    );
    // e1 owns the shared repository (first server wins), so e2 is narrowed to what is its alone.
    expect(targets).toEqual([
      { environmentId: "e1", input },
      { environmentId: "e2", input: { ...input, projectIds: ["p3"] } },
    ]);
  });

  it("sends plain per-server reads while the workspace has not said what it holds", () => {
    const targets = buildActivityTargets(
      [env("e1")],
      [project("p1", "e1", "github.com/fusebox/t3code")],
      false,
      input,
    );
    expect(targets).toEqual([{ environmentId: "e1", input }]);
  });
});

describe("deriveProjectActivity", () => {
  it("counts rows under the repository so a sibling project of the same repository reads them too", () => {
    const projects = [
      project("root", "e1", "github.com/fusebox/t3code"),
      project("sub", "e1", "github.com/fusebox/t3code"),
      project("loner", "e1"),
    ];
    const activity = deriveProjectActivity(
      projects,
      mergedPullRequests({
        entries: [
          pullRequestRow({ environmentId: "e1", projectId: "root" }),
          pullRequestRow({ environmentId: "e1", projectId: "root" }),
        ],
      }),
      mergedLeads({ entries: [{ environmentId: "e1", projectId: "loner" }] }),
    );
    const shared = activity.countsByRepo.get("github.com/fusebox/t3code");
    expect(shared?.pullRequests).toBe(2);
    expect(shared?.pullRequestsAtLeast).toBe(false);
    expect(activity.repoKeyByProject.get("e1:sub")).toBe("github.com/fusebox/t3code");
    // A project with no repository identity keeps its own key rather than vanishing.
    expect(activity.countsByRepo.get("e1:loner")?.leads).toBe(1);
  });

  it("marks every count from a truncated environment as a floor, and none from a whole one", () => {
    const projects = [
      project("t3", "e1", "github.com/fusebox/t3code"),
      project("kev", "e2", "github.com/fusebox/kevfiles"),
    ];
    const activity = deriveProjectActivity(
      projects,
      mergedPullRequests({
        entries: [
          pullRequestRow({ environmentId: "e1", projectId: "t3" }),
          pullRequestRow({
            environmentId: "e2",
            projectId: "kev",
            repository: "fusebox/kevfiles",
          }),
        ],
        // Nothing in a truncated answer proves any one repository was listed whole — the
        // no-search fallback truncates without a cursor — so e1 floors everything it listed.
        truncatedEnvironments: ["e1"],
        nextCursors: { e1: { "github.com fusebox/t3code": "cursor" } },
      }),
      mergedLeads({
        entries: [{ environmentId: "e2", projectId: "kev" }],
        truncatedEnvironments: ["e2"],
      }),
    );
    expect(activity.countsByRepo.get("github.com/fusebox/t3code")?.pullRequestsAtLeast).toBe(true);
    expect(activity.countsByRepo.get("github.com/fusebox/kevfiles")?.pullRequestsAtLeast).toBe(
      false,
    );
    expect(activity.countsByRepo.get("github.com/fusebox/kevfiles")?.leadsAtLeast).toBe(true);
  });
});

describe("sumProjectActivity", () => {
  it("counts a repository once however many member projects hold it", () => {
    const projects = [
      project("root", "e1", "github.com/fusebox/t3code"),
      project("worktree", "e1", "github.com/fusebox/t3code"),
    ];
    const activity = deriveProjectActivity(
      projects,
      mergedPullRequests({
        entries: [pullRequestRow({ environmentId: "e1", projectId: "root" })],
      }),
      null,
    );
    const totals = sumProjectActivity(
      [
        { environmentId: "e1", projectId: "root" },
        { environmentId: "e1", projectId: "worktree" },
      ],
      activity,
    );
    expect(totals.pullRequests).toBe(1);
    expect(totals.leads).toBe(0);
  });
});
