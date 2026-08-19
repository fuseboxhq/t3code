import * as Effect from "effect/Effect";
import type { IssueCapabilities, IssueViewerPermissions } from "@t3tools/contracts";

import * as GitHubIssueCli from "./GitHubIssueCli.ts";
import {
  IssueProviderError,
  type IssueProviderApi,
  type IssueProviderFailure,
} from "./IssueProvider.ts";
import type { GitHubIssueViewerAccess } from "./gitHubIssueJson.ts";

const CAPABILITIES: IssueCapabilities = {
  comment: true,
  actions: ["close", "reopen"],
  search: true,
};

/**
 * What the signed-in account may do here. Closing and reopening go by `viewerCanUpdate`, which
 * GitHub grants to write access and to the issue's own author alike. Commenting needs only read
 * access, except on a locked conversation — where GitHub still lets writers speak, an edge this
 * reads as closed rather than asking a second question for it.
 */
function gitHubIssueViewerPermissions(access: GitHubIssueViewerAccess): IssueViewerPermissions {
  return {
    actions: access.canUpdate ? ["close", "reopen"] : [],
    comment: !access.locked,
  };
}

/** The CLI tags that mean the tool itself is unusable, rather than one request failing. */
function gitHubIssueProviderFailure(
  error: GitHubIssueCli.GitHubIssueCliError,
): IssueProviderFailure {
  if (error._tag === "GitHubCliUnavailableError") return { reason: "missing-tool" };
  if (error._tag === "GitHubCliAuthenticationError") return { reason: "unauthenticated" };
  if (error._tag === "GitHubCliRateLimitError") return { reason: "rate-limited" };
  if (error._tag === "SourceControlRateLimitPausedError") {
    return { reason: "rate-limited", retryAt: error.retryAt };
  }
  return { reason: "failed" };
}

/**
 * The shared `gh` wrapper classifies a not-found exit with pull-request wording. This adapter
 * is where the issue feed normalizes it, so the sentence a reader sees names what they asked
 * about.
 */
function failureDetail(error: GitHubIssueCli.GitHubIssueCliError): string {
  return error._tag === "GitHubPullRequestNotFoundError"
    ? "Issue not found. Check the issue number and try again."
    : error.detail;
}

export const make = Effect.gen(function* () {
  const cli = yield* GitHubIssueCli.GitHubIssueCli;

  const fail = (operation: string) => (error: GitHubIssueCli.GitHubIssueCliError) =>
    new IssueProviderError({
      provider: "github",
      operation,
      ...gitHubIssueProviderFailure(error),
      detail: failureDetail(error),
      cause: error,
    });

  const provider: IssueProviderApi = {
    kind: "github",
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      cli.getViewerLogin({ cwd: input.cwd }).pipe(Effect.mapError(fail("getViewer"))),

    listIssuesAcross: (input) =>
      cli
        .searchIssues({
          cwd: input.cwd,
          host: input.host,
          repositories: input.repositories,
          state: input.state,
          viewer: input.viewer,
          limit: input.limit,
          query: input.query,
          cursor: input.cursor,
          filters: input.filters,
        })
        .pipe(
          Effect.mapError(fail("listIssuesAcross")),
          Effect.map((batch) => ({
            items: batch.items,
            nextCursor: batch.hasNextPage ? batch.endCursor : null,
          })),
        ),

    listIssues: (input) =>
      cli
        .listIssues({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          state: input.state,
          viewer: input.viewer,
          limit: input.limit,
          filters: input.filters,
        })
        .pipe(Effect.mapError(fail("listIssues"))),

    getIssue: (input) =>
      cli.getIssueDetail(input).pipe(
        Effect.mapError(fail("getIssue")),
        Effect.map((detail) => ({
          number: detail.number,
          title: detail.title,
          url: detail.url,
          author: detail.author,
          state: detail.state,
          commentCount: detail.commentCount,
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
          labels: detail.labels,
          assignees: detail.assignees,
          body: detail.body,
          closedAt: detail.closedAt,
          viewerPermissions: gitHubIssueViewerPermissions({
            canUpdate: detail.viewerCanUpdate,
            locked: detail.locked,
          }),
        })),
      ),

    getIssueActivity: (input) =>
      cli.getIssueActivity(input).pipe(
        Effect.mapError(fail("getIssueActivity")),
        Effect.map((page) => ({
          comments: page.comments,
          commentCount: page.commentCount,
          commentsTruncated: page.hasNextPage,
          nextCursor: page.hasNextPage ? page.endCursor : null,
        })),
      ),

    getViewerPermissions: (input) =>
      cli
        .getViewerAccess(input)
        .pipe(
          Effect.mapError(fail("getViewerPermissions")),
          Effect.map(gitHubIssueViewerPermissions),
        ),

    comment: (input) => cli.commentOnIssue(input).pipe(Effect.mapError(fail("comment"))),

    setState: (input) => cli.setIssueState(input).pipe(Effect.mapError(fail("setState"))),
  };

  return provider;
});
