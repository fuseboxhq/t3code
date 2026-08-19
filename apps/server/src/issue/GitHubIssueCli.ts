import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { IssueAction, IssueListFilters, IssueListState } from "@t3tools/contracts";
import { resolvePullRequestAuthorFilter } from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubGraphQlBudget from "../sourceControl/githubGraphQlBudget.ts";
import type * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import {
  GitHubRepositorySelectorError,
  GitHubViewerLoginUnavailableError,
  parseRepositorySelector,
} from "../pullRequest/GitHubPullRequestCli.ts";
import { encodeGraphQlRequestJson } from "../pullRequest/gitHubPullRequestJson.ts";
import {
  ISSUE_ACTIVITY_GRAPHQL_QUERY,
  ISSUE_DETAIL_GRAPHQL_QUERY,
  ISSUE_LIST_JSON_FIELDS,
  ISSUE_PERMISSIONS_GRAPHQL_QUERY,
  ISSUE_SEARCH_CURSOR,
  ISSUE_SEARCH_MAX_ROWS,
  buildIssueSearchQuery,
  decodeIssueActivityJson,
  decodeIssueDetailJson,
  decodeIssueListJson,
  decodeIssuePermissionsJson,
  decodeIssueSearchJson,
  issueSearchGraphQlQuery,
  type GitHubIssueActivityPage,
  type GitHubIssueDetail,
  type GitHubIssueListItem,
  type GitHubIssueSearchBatch,
  type GitHubIssueViewerAccess,
} from "./gitHubIssueJson.ts";

/** Names the read that produced unusable output, so a failure reports the call it came from. */
class GitHubIssueReadError extends Schema.TaggedErrorClass<GitHubIssueReadError>()(
  "GitHubIssueReadError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `GitHub CLI returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `GitHub CLI failed in ${this.operation}: ${this.detail}`;
  }
}

/** Not a decode failure: the named issue does not exist on the host. */
class GitHubIssueNotFoundError extends Schema.TaggedErrorClass<GitHubIssueNotFoundError>()(
  "GitHubIssueNotFoundError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    operation: Schema.String,
  },
) {
  get detail(): string {
    return "Issue not found. Check the issue number and try again.";
  }

  override get message(): string {
    return `GitHub CLI failed in ${this.operation}: ${this.detail}`;
  }
}

/** Not a decode failure: the reader asked to carry on from a cursor this feed never issued. */
class GitHubIssueCursorError extends Schema.TaggedErrorClass<GitHubIssueCursorError>()(
  "GitHubIssueCursorError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    operation: Schema.String,
  },
) {
  get detail(): string {
    return "The listing could not be carried on from where it left off.";
  }

  override get message(): string {
    return `GitHub CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export type GitHubIssueCliError =
  | GitHubCli.GitHubCliError
  | GitHubIssueReadError
  | GitHubIssueNotFoundError
  | GitHubIssueCursorError
  | GitHubRepositorySelectorError
  | GitHubViewerLoginUnavailableError
  | SourceControlRateLimit.SourceControlRateLimitPausedError;

export class GitHubIssueCli extends Context.Service<
  GitHubIssueCli,
  {
    readonly getViewerLogin: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string, GitHubIssueCliError>;

    readonly searchIssues: (input: {
      readonly cwd: string;
      readonly host: string;
      readonly repositories: ReadonlyArray<string>;
      readonly state: IssueListState;
      readonly viewer: string;
      readonly limit: number;
      readonly query?: string | undefined;
      readonly cursor?: string | undefined;
      readonly filters?: IssueListFilters | undefined;
    }) => Effect.Effect<GitHubIssueSearchBatch, GitHubIssueCliError>;

    readonly listIssues: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly state: IssueListState;
      readonly viewer: string;
      readonly limit: number;
      readonly filters?: IssueListFilters | undefined;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<GitHubIssueListItem>; readonly truncated: boolean },
      GitHubIssueCliError
    >;

    readonly getIssueDetail: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubIssueDetail, GitHubIssueCliError>;

    readonly getIssueActivity: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly cursor?: string | undefined;
    }) => Effect.Effect<GitHubIssueActivityPage, GitHubIssueCliError>;

    readonly getViewerAccess: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubIssueViewerAccess, GitHubIssueCliError>;

    readonly commentOnIssue: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitHubIssueCliError>;

    readonly setIssueState: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly action: IssueAction;
    }) => Effect.Effect<void, GitHubIssueCliError>;
  }
>()("t3/issue/GitHubIssueCli") {}

/**
 * The same narrowings over a row that has already arrived, for the search-free fallback: the
 * list API cannot express an OR label group or exclusion, so its rows are judged here instead.
 */
function matchesIssueFilters(
  item: GitHubIssueListItem,
  filters: IssueListFilters | undefined,
  viewer: string,
): boolean {
  if (filters === undefined) return true;
  const labels = item.labels.map((label) => label.name.trim().toLowerCase());
  const holds = (label: string) => labels.includes(label.trim().toLowerCase());
  return (
    (filters.labels === undefined || filters.labels.every((group) => group.some(holds))) &&
    (filters.excludedLabels === undefined || !filters.excludedLabels.some(holds)) &&
    (filters.author === undefined ||
      item.author?.login.toLowerCase() ===
        resolvePullRequestAuthorFilter(filters.author, viewer).toLowerCase())
  );
}

export const make = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;
  const graphQlBudget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;

  // `gh` resolves a bare `owner/repo` against github.com; naming the host keeps a GitHub
  // Enterprise repository on its own install.
  const repositoryArgs = (input: { readonly host: string; readonly repository: string }) => [
    "--repo",
    `${input.host}/${input.repository}`,
  ];

  /**
   * A GraphQL read whose answer is decoded, sharing the workspace-wide point budget with the
   * pull-request feature. Mirrors `GitHubPullRequestCli`'s read: module-composed values travel
   * as `-f`/`-F` flags, and reader-supplied words go with the document over stdin, because argv
   * is visible in process listings and echoed back inside process-runner failure messages.
   */
  const graphqlRead = <A>(input: {
    readonly cwd: string;
    readonly host: string;
    readonly operation: string;
    readonly allowReserve?: boolean | undefined;
    /** Variables as `-f`/`-F` flags, for values this module composed or validated itself. */
    readonly variables?: ReadonlyArray<readonly [string, string]>;
    /** Variables carrying words the reader typed, sent with the document over stdin. */
    readonly privateVariables?: Readonly<Record<string, string>>;
    readonly query: string;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, GitHubIssueCliError> =>
    graphQlBudget
      .query(
        input.host,
        input.query,
        input.allowReserve === true ? { allowReserve: true } : undefined,
      )
      .pipe(
        Effect.flatMap((query) =>
          github.execute(
            input.privateVariables === undefined
              ? {
                  cwd: input.cwd,
                  args: [
                    "api",
                    "graphql",
                    "--hostname",
                    input.host,
                    ...(input.variables ?? []).flat(),
                    "-f",
                    `query=${query}`,
                  ],
                }
              : {
                  cwd: input.cwd,
                  args: ["api", "graphql", "--hostname", input.host, "--input", "-"],
                  stdin: encodeGraphQlRequestJson({ query, variables: input.privateVariables }),
                },
          ),
        ),
        Effect.tap((result) => graphQlBudget.observe(input.host, result.stdout)),
        Effect.flatMap((result) => {
          const decoded = input.decode(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new GitHubIssueReadError({
                  command: "gh",
                  cwd: input.cwd,
                  operation: input.operation,
                  cause: decoded.failure,
                }),
              );
        }),
      );

  const repositoryVariables = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly operation: string;
    readonly number: number;
  }): Effect.Effect<ReadonlyArray<readonly [string, string]>, GitHubRepositorySelectorError> => {
    const { owner, name } = parseRepositorySelector(input.repository);
    if (owner.length === 0 || name.length === 0) {
      return Effect.fail(
        new GitHubRepositorySelectorError({
          command: "gh",
          cwd: input.cwd,
          operation: input.operation,
        }),
      );
    }
    return Effect.succeed([
      ["-f", `owner=${owner}`],
      ["-f", `name=${name}`],
      ["-F", `number=${input.number}`],
    ] as const);
  };

  const notFound = (input: { readonly cwd: string; readonly operation: string }) =>
    new GitHubIssueNotFoundError({ command: "gh", cwd: input.cwd, operation: input.operation });

  return GitHubIssueCli.of({
    getViewerLogin: (input) =>
      github.execute({ cwd: input.cwd, args: ["api", "user", "--jq", ".login"] }).pipe(
        Effect.flatMap((result) => {
          const login = result.stdout.trim();
          return login.length > 0
            ? Effect.succeed(login)
            : Effect.fail(new GitHubViewerLoginUnavailableError({ command: "gh", cwd: input.cwd }));
        }),
      ),

    searchIssues: (input) => {
      const query = buildIssueSearchQuery(input);
      if (query === null) {
        return Effect.fail(
          new GitHubRepositorySelectorError({
            command: "gh",
            cwd: input.cwd,
            operation: "searchIssues",
          }),
        );
      }
      // The cursor arrives from a client and goes to the host as a variable; anything that does
      // not read as one of GitHub's own cursors is a value this feed never issued.
      if (input.cursor !== undefined && !ISSUE_SEARCH_CURSOR.test(input.cursor)) {
        return Effect.fail(
          new GitHubIssueCursorError({ command: "gh", cwd: input.cwd, operation: "searchIssues" }),
        );
      }
      // No probe row here, deliberately: the continuation is GitHub's own positional cursor,
      // which stands exactly after the last row served — a row fetched and sliced off would be
      // skipped by the next slice. `hasNextPage` answers "is there more" without costing a row.
      const rows = Math.min(Math.max(input.limit, 1), ISSUE_SEARCH_MAX_ROWS);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "searchIssues",
        // The reader's own words are in the query, so it travels over stdin rather than in
        // argv; an absent cursor is an absent variable, which GraphQL reads as null.
        privateVariables: {
          q: query,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        },
        query: issueSearchGraphQlQuery(rows),
        decode: decodeIssueSearchJson,
      });
    },

    listIssues: (input) => {
      // Single-name label groups narrow on the host (`gh` ANDs repeated --label flags, which is
      // group semantics); OR groups and exclusions are judged locally over the decoded rows.
      const hostLabels = (input.filters?.labels ?? []).flatMap((group) =>
        group.length === 1 && group[0] !== undefined ? [group[0]] : [],
      );
      return github
        .execute({
          cwd: input.cwd,
          args: [
            "issue",
            "list",
            ...repositoryArgs(input),
            "--state",
            input.state,
            ...hostLabels.flatMap((label) => ["--label", label]),
            "--limit",
            // One extra row reveals that the repository has more than the page shows.
            String(input.limit + 1),
            "--json",
            ISSUE_LIST_JSON_FIELDS,
          ],
        })
        .pipe(
          Effect.flatMap((result) => {
            const raw = result.stdout.trim();
            if (raw.length === 0) return Effect.succeed({ items: [], truncated: false });
            const decoded = decodeIssueListJson(raw);
            if (!Result.isSuccess(decoded)) {
              return Effect.fail(
                new GitHubIssueReadError({
                  command: "gh",
                  cwd: input.cwd,
                  operation: "listIssues",
                  cause: decoded.failure,
                }),
              );
            }
            const items = decoded.success.items.filter((item) =>
              matchesIssueFilters(item, input.filters, input.viewer),
            );
            return Effect.succeed({
              items: items.slice(0, input.limit),
              truncated: decoded.success.rawCount > input.limit,
            });
          }),
        );
    },

    getIssueDetail: (input) =>
      repositoryVariables({ ...input, operation: "getIssueDetail" }).pipe(
        Effect.flatMap((variables) =>
          graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "getIssueDetail",
            variables,
            query: ISSUE_DETAIL_GRAPHQL_QUERY,
            decode: decodeIssueDetailJson,
          }),
        ),
        Effect.flatMap((detail) =>
          detail === null
            ? Effect.fail(notFound({ cwd: input.cwd, operation: "getIssueDetail" }))
            : Effect.succeed(detail),
        ),
      ),

    getIssueActivity: (input) => {
      if (input.cursor !== undefined && !ISSUE_SEARCH_CURSOR.test(input.cursor)) {
        return Effect.fail(
          new GitHubIssueCursorError({
            command: "gh",
            cwd: input.cwd,
            operation: "getIssueActivity",
          }),
        );
      }
      return repositoryVariables({ ...input, operation: "getIssueActivity" }).pipe(
        Effect.flatMap((variables) =>
          graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "getIssueActivity",
            variables: [
              ...variables,
              // Checked against the cursor shape above, so it may ride in argv like the rest.
              ...(input.cursor === undefined ? [] : [["-f", `cursor=${input.cursor}`] as const]),
            ],
            query: ISSUE_ACTIVITY_GRAPHQL_QUERY,
            decode: decodeIssueActivityJson,
          }),
        ),
        Effect.flatMap((page) =>
          page === null
            ? Effect.fail(notFound({ cwd: input.cwd, operation: "getIssueActivity" }))
            : Effect.succeed(page),
        ),
      );
    },

    getViewerAccess: (input) =>
      repositoryVariables({ ...input, operation: "getViewerAccess" }).pipe(
        Effect.flatMap((variables) =>
          graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "getViewerAccess",
            // A permission read guards an interactive write, so it may dip into the reserve.
            allowReserve: true,
            variables,
            query: ISSUE_PERMISSIONS_GRAPHQL_QUERY,
            decode: decodeIssuePermissionsJson,
          }),
        ),
        Effect.flatMap((access) =>
          access === null
            ? Effect.fail(notFound({ cwd: input.cwd, operation: "getViewerAccess" }))
            : Effect.succeed(access),
        ),
      ),

    commentOnIssue: (input) =>
      github
        .execute({
          cwd: input.cwd,
          args: [
            "issue",
            "comment",
            String(input.number),
            ...repositoryArgs(input),
            // The body is the reader's own words, so it travels over stdin rather than in argv.
            "--body-file",
            "-",
          ],
          stdin: input.body,
        })
        .pipe(Effect.asVoid),

    setIssueState: (input) =>
      github
        .execute({
          cwd: input.cwd,
          args: [
            "issue",
            input.action === "close" ? "close" : "reopen",
            String(input.number),
            ...repositoryArgs(input),
          ],
        })
        .pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitHubIssueCli, make);
