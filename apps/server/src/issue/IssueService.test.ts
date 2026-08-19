import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import {
  IssueProviderError,
  type IssueProviderApi,
  type ProviderBatchedIssue,
} from "./IssueProvider.ts";
import { IssueProviderRegistry, fromProviders } from "./IssueProviderRegistry.ts";
import * as IssueService from "./IssueService.ts";

function project(input: {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repository: string;
}): OrchestrationProjectShell {
  return {
    id: input.id as ProjectId,
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    repositoryIdentity: {
      canonicalKey: `github.com/${input.repository}`,
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: `https://github.com/${input.repository}.git`,
      },
      provider: "github",
      displayName: input.repository,
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}

function issue(repository: string, number: number, updatedAt: string): ProviderBatchedIssue {
  return {
    repository,
    number,
    title: `Lead ${number}`,
    url: `https://github.com/${repository}/issues/${number}`,
    author: { login: "agent", name: null, avatarUrl: null },
    state: "open",
    commentCount: 0,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt,
    labels: [{ name: "lead", color: "FBCA04" }],
    assignees: [],
  };
}

/** A provider whose every call is supplied by the test; anything unset succeeds emptily. */
function fakeProvider(overrides: Partial<IssueProviderApi> = {}): IssueProviderApi {
  return {
    kind: "github",
    capabilities: { comment: true, actions: ["close", "reopen"], search: true },
    getViewer: () => Effect.succeed("kev"),
    getViewerPermissions: () => Effect.succeed({ actions: ["close", "reopen"], comment: true }),
    listIssuesAcross: () => Effect.succeed({ items: [], nextCursor: null }),
    listIssues: () => Effect.succeed({ items: [], truncated: false }),
    getIssue: () => Effect.die("unused"),
    getIssueActivity: () => Effect.die("unused"),
    comment: () => Effect.void,
    setState: () => Effect.void,
    ...overrides,
  };
}

function makeService(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly provider: IssueProviderApi;
}) {
  return IssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(IssueProviderRegistry, fromProviders([input.provider])),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: input.projects,
              threads: [],
              updatedAt: "2026-07-01T00:00:00Z",
            }),
        }),
        SourceControlRateLimit.layer,
      ),
    ),
  );
}

it.effect("lists a host in one search and de-duplicates worktrees of one repository", () =>
  Effect.gen(function* () {
    const asked: Array<ReadonlyArray<string>> = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "fusebox/t3code" }),
        // A worktree of the same repository must not double the listing.
        project({
          id: "p2",
          title: "t3code wt",
          workspaceRoot: "/b",
          repository: "fusebox/t3code",
        }),
        project({
          id: "p3",
          title: "kevfiles",
          workspaceRoot: "/c",
          repository: "fusebox/kevfiles",
        }),
      ],
      provider: fakeProvider({
        listIssuesAcross: (input) => {
          asked.push(input.repositories);
          return Effect.succeed({
            items: [
              issue("fusebox/t3code", 1, "2026-08-18T10:00:00Z"),
              issue("fusebox/kevfiles", 2, "2026-08-18T11:00:00Z"),
            ],
            nextCursor: null,
          });
        },
      }),
    });

    const result = yield* service.list({ state: "open", filters: { labels: [["lead"]] } });

    assert.deepStrictEqual(asked, [["fusebox/kevfiles", "fusebox/t3code"]]);
    assert.strictEqual(result.entries.length, 2);
    // Newest update first, whatever order the repositories answered in.
    assert.strictEqual(result.entries[0]?.number, 2);
    assert.strictEqual(result.entries[1]?.projectId, "p1");
    assert.strictEqual(result.viewers["github.com"], "kev");
    assert.isFalse(result.truncated);
    assert.deepStrictEqual(result.nextCursors, {});
  }),
);

it.effect("carries a listing on through the batch cursor, and refuses a forged one", () =>
  Effect.gen(function* () {
    const cursors: Array<string | undefined> = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "fusebox/t3code" }),
      ],
      provider: fakeProvider({
        listIssuesAcross: (input) => {
          cursors.push(input.cursor);
          return input.cursor === undefined
            ? Effect.succeed({
                items: [issue("fusebox/t3code", 1, "2026-08-18T10:00:00Z")],
                nextCursor: "Y3Vyc29yOjEwMA==",
              })
            : Effect.succeed({
                items: [issue("fusebox/t3code", 2, "2026-08-17T10:00:00Z")],
                nextCursor: null,
              });
        },
        // The first slice's silence probe must not fire for repositories that answered.
        listIssues: () => Effect.die("the fallback must not run"),
      }),
    });

    const first = yield* service.list({ state: "open" });
    assert.isTrue(first.truncated);
    const continuation = first.nextCursors["github.com #0"];
    assert.isDefined(continuation);

    const second = yield* service.list({
      state: "open",
      cursors: { "github.com #0": continuation! },
    });
    assert.deepStrictEqual(cursors, [undefined, "Y3Vyc29yOjEwMA=="]);
    assert.strictEqual(second.entries[0]?.number, 2);
    assert.isFalse(second.truncated);

    const forged = yield* service
      .list({ state: "open", cursors: { "github.com #0": "v1|deadbeef|forged" } })
      .pipe(Effect.flip);
    assert.strictEqual(forged._tag, "IssueOperationError");
  }),
);

it.effect("reads a search-silent repository on its own before believing the silence", () =>
  Effect.gen(function* () {
    const fallbackReads: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "fusebox/t3code" }),
        project({ id: "p2", title: "renamed", workspaceRoot: "/b", repository: "fusebox/renamed" }),
      ],
      provider: fakeProvider({
        listIssuesAcross: () =>
          Effect.succeed({
            items: [issue("fusebox/t3code", 1, "2026-08-18T10:00:00Z")],
            nextCursor: null,
          }),
        listIssues: (input) => {
          fallbackReads.push(input.repository);
          return Effect.succeed({
            items: [
              (({ repository: _repository, ...rest }) => rest)(
                issue("fusebox/renamed", 9, "2026-08-10T10:00:00Z"),
              ),
            ],
            truncated: false,
          });
        },
      }),
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(fallbackReads, ["fusebox/renamed"]);
    assert.strictEqual(result.entries.length, 2);
    assert.strictEqual(result.entries[1]?.number, 9);
  }),
);

it.effect("one unreadable repository degrades to an error entry, not a blank page", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "fusebox/t3code" }),
        project({ id: "p2", title: "gone", workspaceRoot: "/b", repository: "fusebox/gone" }),
      ],
      provider: fakeProvider({
        listIssuesAcross: () =>
          Effect.succeed({
            items: [issue("fusebox/t3code", 1, "2026-08-18T10:00:00Z")],
            nextCursor: null,
          }),
        listIssues: () =>
          Effect.fail(
            new IssueProviderError({
              provider: "github",
              operation: "listIssues",
              reason: "failed",
              detail: "HTTP 404",
            }),
          ),
      }),
    });

    const result = yield* service.list({ state: "open" });

    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0]?.projectId, "p2");
  }),
);

it.effect("refuses a detail read whose repository does not belong to the named project", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "fusebox/t3code" }),
      ],
      provider: fakeProvider({
        getIssue: () => Effect.die("a spoofed repository must never reach the provider"),
      }),
    });

    const error = yield* service
      .detail({ projectId: "p1" as ProjectId, repository: "fusebox/other-repo", number: 1 })
      .pipe(Effect.flip);

    if (error._tag !== "IssueOperationError") return assert.fail(`unexpected ${error._tag}`);
    assert.include(error.detail, "does not belong");
  }),
);

it.effect("a comment invalidates the listing, the detail, and the activity for every client", () =>
  Effect.gen(function* () {
    let listReads = 0;
    let activityReads = 0;
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "fusebox/t3code" }),
      ],
      provider: fakeProvider({
        listIssuesAcross: () => {
          listReads += 1;
          return Effect.succeed({ items: [], nextCursor: null });
        },
        getIssueActivity: () => {
          activityReads += 1;
          return Effect.succeed({
            comments: [],
            commentCount: activityReads,
            commentsTruncated: false,
            nextCursor: null,
          });
        },
      }),
    });
    const ref = { projectId: "p1" as ProjectId, repository: "fusebox/t3code", number: 1 };

    yield* service.list({ state: "open" });
    yield* service.list({ state: "open" });
    assert.strictEqual(listReads, 1);
    yield* service.activity(ref);
    yield* service.activity(ref);
    assert.strictEqual(activityReads, 1);

    yield* service.comment({ ...ref, body: "On it." });

    // The epochs moved, so the same reads now go back to the host.
    yield* service.list({ state: "open" });
    yield* service.activity(ref);
    assert.strictEqual(listReads, 2);
    assert.strictEqual(activityReads, 2);
  }),
);

it.effect("refuses a comment the host's own permission read does not allow", () =>
  Effect.gen(function* () {
    let commentWrites = 0;
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "fusebox/t3code" }),
      ],
      provider: fakeProvider({
        getViewerPermissions: () =>
          Effect.succeed({ actions: ["close", "reopen"], comment: false }),
        comment: () => {
          commentWrites += 1;
          return Effect.void;
        },
      }),
    });

    const error = yield* service
      .comment({
        projectId: "p1" as ProjectId,
        repository: "fusebox/t3code",
        number: 1,
        body: "On it.",
      })
      .pipe(Effect.flip);

    if (error._tag !== "IssueOperationError") return assert.fail(`unexpected ${error._tag}`);
    assert.include(error.detail, "does not accept comments");
    assert.strictEqual(commentWrites, 0);
  }),
);

it.effect("refuses a mutation the host's own permission read does not allow", () =>
  Effect.gen(function* () {
    let stateWrites = 0;
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "fusebox/t3code" }),
      ],
      provider: fakeProvider({
        getViewerPermissions: () => Effect.succeed({ actions: [], comment: true }),
        setState: () => {
          stateWrites += 1;
          return Effect.void;
        },
      }),
    });

    const error = yield* service
      .setState({
        projectId: "p1" as ProjectId,
        repository: "fusebox/t3code",
        number: 1,
        action: "close",
      })
      .pipe(Effect.flip);

    if (error._tag !== "IssueOperationError") return assert.fail(`unexpected ${error._tag}`);
    assert.include(error.detail, "write access");
    assert.strictEqual(stateWrites, 0);
  }),
);
