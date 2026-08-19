import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  ISSUE_SEARCH_MAX_ROWS,
  buildIssueSearchQuery,
  decodeIssueActivityJson,
  decodeIssueDetailJson,
  decodeIssueListJson,
  decodeIssuePermissionsJson,
  decodeIssueSearchJson,
  issueSearchGraphQlQuery,
} from "./gitHubIssueJson.ts";

describe("buildIssueSearchQuery", () => {
  it("pins the issue type, states, labels, order, and repositories", () => {
    const query = buildIssueSearchQuery({
      repositories: ["fusebox/t3code", "fusebox/kevfiles"],
      state: "open",
      viewer: "kev",
      filters: { labels: [["lead"]] },
    });
    assert.strictEqual(
      query,
      'is:issue is:open label:"lead" sort:updated-desc repo:fusebox/t3code repo:fusebox/kevfiles',
    );
  });

  it("quotes label values so a crafted label cannot smuggle qualifiers", () => {
    const query = buildIssueSearchQuery({
      repositories: ["fusebox/t3code"],
      state: "all",
      viewer: "kev",
      filters: {
        labels: [['lead" is:pr author:someone']],
        excludedLabels: ["wontfix or:this"],
      },
    });
    // The double quote is dropped and the value stays one quoted token.
    assert.strictEqual(
      query,
      'is:issue label:"lead is:pr author:someone" -label:"wontfix or:this" sort:updated-desc repo:fusebox/t3code',
    );
  });

  it("keeps free text one literal phrase", () => {
    const query = buildIssueSearchQuery({
      repositories: ["fusebox/t3code"],
      state: "open",
      viewer: "kev",
      query: 'crash "on startup" label:oops',
    });
    assert.strictEqual(
      query,
      'is:issue is:open "crash \\"on startup\\" label:oops" sort:updated-desc repo:fusebox/t3code',
    );
  });

  it("resolves author:me to the signed-in login", () => {
    const query = buildIssueSearchQuery({
      repositories: ["fusebox/t3code"],
      state: "open",
      viewer: "kev",
      filters: { author: "me" },
    });
    assert.strictEqual(
      query,
      'is:issue is:open author:"kev" sort:updated-desc repo:fusebox/t3code',
    );
  });

  it("clamps the search page size to GitHub's ceiling", () => {
    assert.include(issueSearchGraphQlQuery(500), `first: ${ISSUE_SEARCH_MAX_ROWS},`);
    assert.include(issueSearchGraphQlQuery(0), "first: 1,");
  });

  it("refuses a repository selector GitHub cannot address", () => {
    assert.isNull(
      buildIssueSearchQuery({
        repositories: ["fusebox/t3code", "evil repo/x is:pr"],
        state: "open",
        viewer: "kev",
      }),
    );
    assert.isNull(buildIssueSearchQuery({ repositories: [], state: "open", viewer: "kev" }));
  });
});

const SEARCH_FIXTURE = JSON.stringify({
  data: {
    search: {
      pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29yOjEwMA==" },
      nodes: [
        {
          number: 12,
          title: "Lead: flaky sidebar test",
          url: "https://github.com/fusebox/t3code/issues/12",
          author: { login: "kev", name: "Kevin", avatarUrl: "https://a/kev" },
          state: "OPEN",
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-18T10:00:00Z",
          repository: { nameWithOwner: "fusebox/t3code" },
          labels: { nodes: [{ name: "lead", color: "FBCA04" }, null] },
          assignees: { nodes: [{ login: "julius", name: null, avatarUrl: null }] },
          comments: { totalCount: 3 },
        },
        // A node the fragment did not match (not an Issue) arrives as an empty object.
        {},
      ],
    },
  },
  rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2026-08-19T00:00:00Z" },
});

describe("decoders", () => {
  it("decodes a search page and skips non-issue nodes", () => {
    const decoded = decodeIssueSearchJson(SEARCH_FIXTURE);
    assert.isTrue(Result.isSuccess(decoded));
    if (!Result.isSuccess(decoded)) return;
    const batch = decoded.success;
    assert.strictEqual(batch.items.length, 1);
    assert.strictEqual(batch.rawCount, 2);
    assert.isTrue(batch.hasNextPage);
    assert.strictEqual(batch.endCursor, "Y3Vyc29yOjEwMA==");
    const item = batch.items[0]!;
    assert.strictEqual(item.repository, "fusebox/t3code");
    assert.strictEqual(item.number, 12);
    assert.strictEqual(item.state, "open");
    assert.strictEqual(item.commentCount, 3);
    assert.deepStrictEqual(item.labels, [{ name: "lead", color: "FBCA04" }]);
    assert.deepStrictEqual(item.assignees, [{ login: "julius", name: null, avatarUrl: null }]);
  });

  it("decodes an issue detail, and reports a missing issue as null", () => {
    const decoded = decodeIssueDetailJson(
      JSON.stringify({
        data: {
          repository: {
            issue: {
              number: 12,
              title: "Lead: flaky sidebar test",
              body: "Seen while working on #7491.",
              url: "https://github.com/fusebox/t3code/issues/12",
              author: { login: "kev", avatarUrl: null },
              state: "OPEN",
              locked: false,
              viewerCanUpdate: true,
              createdAt: "2026-08-01T00:00:00Z",
              updatedAt: "2026-08-18T10:00:00Z",
              closedAt: null,
              labels: { nodes: [{ name: "lead", color: null }] },
              assignees: { nodes: [] },
              comments: { totalCount: 2 },
            },
          },
        },
      }),
    );
    assert.isTrue(Result.isSuccess(decoded));
    if (!Result.isSuccess(decoded)) return;
    assert.strictEqual(decoded.success?.state, "open");
    assert.strictEqual(decoded.success?.viewerCanUpdate, true);
    assert.strictEqual(decoded.success?.commentCount, 2);

    const missing = decodeIssueDetailJson(
      JSON.stringify({ data: { repository: { issue: null } } }),
    );
    assert.isTrue(Result.isSuccess(missing));
    if (!Result.isSuccess(missing)) return;
    assert.isNull(missing.success);
  });

  it("decodes an activity page with its continuation", () => {
    const decoded = decodeIssueActivityJson(
      JSON.stringify({
        data: {
          repository: {
            issue: {
              comments: {
                totalCount: 60,
                pageInfo: { hasNextPage: true, endCursor: "abc" },
                nodes: [
                  {
                    id: "IC_1",
                    author: { login: "agent", avatarUrl: null },
                    body: "Raised while fixing the sidebar.",
                    createdAt: "2026-08-18T10:00:00Z",
                    url: "https://github.com/fusebox/t3code/issues/12#issuecomment-1",
                  },
                  null,
                ],
              },
            },
          },
        },
      }),
    );
    assert.isTrue(Result.isSuccess(decoded));
    if (!Result.isSuccess(decoded)) return;
    assert.strictEqual(decoded.success?.comments.length, 1);
    assert.strictEqual(decoded.success?.commentCount, 60);
    assert.isTrue(decoded.success?.hasNextPage);
    assert.strictEqual(decoded.success?.endCursor, "abc");
  });

  it("decodes viewer permissions with locked/canUpdate defaults, null for a missing issue", () => {
    const decoded = decodeIssuePermissionsJson(
      JSON.stringify({ data: { repository: { issue: { viewerCanUpdate: true } } } }),
    );
    assert.isTrue(Result.isSuccess(decoded));
    if (!Result.isSuccess(decoded)) return;
    // `locked` absent defaults to false, so commenting stays open rather than refused.
    assert.deepStrictEqual(decoded.success, { canUpdate: true, locked: false });

    const missing = decodeIssuePermissionsJson(JSON.stringify({ data: { repository: null } }));
    assert.isTrue(Result.isSuccess(missing));
    if (!Result.isSuccess(missing)) return;
    assert.isNull(missing.success);
  });

  it("decodes `gh issue list` rows and skips a malformed one", () => {
    const decoded = decodeIssueListJson(
      JSON.stringify([
        {
          number: 7,
          title: "Lead: dead code in scripts",
          url: "https://github.com/fusebox/t3code/issues/7",
          author: { login: "kev" },
          state: "OPEN",
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-02T00:00:00Z",
          labels: [{ name: "lead", color: "FBCA04" }],
          assignees: [],
        },
        { number: "not-a-number" },
      ]),
    );
    assert.isTrue(Result.isSuccess(decoded));
    if (!Result.isSuccess(decoded)) return;
    assert.strictEqual(decoded.success.items.length, 1);
    assert.strictEqual(decoded.success.rawCount, 2);
    assert.strictEqual(decoded.success.items[0]?.state, "open");
  });
});
