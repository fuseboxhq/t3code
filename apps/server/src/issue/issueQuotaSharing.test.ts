import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubGraphQlBudget from "../sourceControl/githubGraphQlBudget.ts";
import * as GitHubPullRequestCli from "../pullRequest/GitHubPullRequestCli.ts";
import * as GitHubIssueCli from "./GitHubIssueCli.ts";

// A fixed instant, deliberately: `it.effect` runs under the TestClock, whose now is epoch 0,
// and the budget compares resetAt against that clock — so this window can never lapse out
// from under the test, whatever wall-clock date it runs on.
const RESET_AT = "2027-01-01T00:00:00Z";

/**
 * The issue feed and the pull-request feature draw on one GitHub GraphQL point budget. This
 * proves the sharing is real: an issue search that observes a nearly spent quota pauses the
 * next pull-request search on the same host, without that search ever reaching `gh`.
 */
it.effect("an issue read's observed quota pauses the pull-request feature's next read", () =>
  Effect.gen(function* () {
    let executions = 0;
    // A search page with nothing in it, whose rateLimit answer reports the host quota nearly
    // spent: 400 remaining of 5000 is inside the 10% reserve ordinary reads may not touch.
    const depletedSearchAnswer = `{
      "data": {
        "search": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
        "rateLimit": { "cost": 1, "limit": 5000, "remaining": 400, "resetAt": "${RESET_AT}" }
      }
    }`;
    const budget = yield* GitHubGraphQlBudget.make;
    const dependencies = Layer.mergeAll(
      Layer.succeed(GitHubGraphQlBudget.GitHubGraphQlBudget, budget),
      Layer.mock(GitHubCli.GitHubCli)({
        execute: () => {
          executions += 1;
          return Effect.succeed({
            stdout: depletedSearchAnswer,
            stderr: "",
            stdoutTruncated: false,
          } as never);
        },
      }),
    );
    const issueCli = yield* GitHubIssueCli.make.pipe(Effect.provide(dependencies));
    const pullRequestCli = yield* GitHubPullRequestCli.make.pipe(Effect.provide(dependencies));

    yield* issueCli.searchIssues({
      cwd: "/repo",
      host: "github.com",
      repositories: ["fusebox/t3code"],
      state: "open",
      viewer: "kev",
      limit: 100,
      filters: { labels: [["lead"]] },
    });
    assert.strictEqual(executions, 1);

    const paused = yield* pullRequestCli
      .searchPullRequests({
        cwd: "/repo",
        host: "github.com",
        repositories: ["fusebox/t3code"],
        state: "open",
        involvement: "all",
        viewer: "kev",
        limit: 99,
      })
      .pipe(Effect.flip);

    assert.strictEqual(paused._tag, "SourceControlRateLimitPausedError");
    // The pause came from the shared budget, before a second `gh` process was ever spawned.
    assert.strictEqual(executions, 1);
  }),
);
