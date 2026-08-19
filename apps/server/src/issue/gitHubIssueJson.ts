import type * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  resolvePullRequestAuthorFilter,
  type IssueComment,
  type IssueListFilters,
  type IssueListState,
  type IssueState,
  type PullRequestActor,
  type PullRequestLabel,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import {
  SEARCH_REPOSITORY,
  qualifierValue,
  searchPhrase,
} from "../pullRequest/GitHubPullRequestCli.ts";

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

/**
 * GitHub's ceiling on a search page: `first: 101` is refused with EXCESSIVE_PAGINATION,
 * `first: 100` is not.
 */
export const ISSUE_SEARCH_MAX_ROWS = 100;

/** Comments read per activity page, bounded so a long conversation pages rather than floods. */
const ISSUE_ACTIVITY_PAGE_SIZE = 50;

/**
 * The one search that answers a whole host's issue listing, carried on by GitHub's own opaque
 * `endCursor` — which is what makes a further slice exact however many rows share one update
 * instant. The reader-supplied query travels as a variable over stdin, never in the document.
 */
export function issueSearchGraphQlQuery(rows: number): string {
  return `query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: ${Math.min(Math.max(Math.trunc(rows), 1), ISSUE_SEARCH_MAX_ROWS)}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        number
        title
        url
        author { login avatarUrl ... on User { name } }
        state
        createdAt
        updatedAt
        repository { nameWithOwner }
        labels(first: 20) { nodes { name color } }
        assignees(first: 10) { nodes { login name avatarUrl } }
        comments { totalCount }
      }
    }
  }
}`;
}

export const ISSUE_DETAIL_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      title
      body
      url
      author { login avatarUrl ... on User { name } }
      state
      locked
      viewerCanUpdate
      createdAt
      updatedAt
      closedAt
      labels(first: 20) { nodes { name color } }
      assignees(first: 10) { nodes { login name avatarUrl } }
      comments { totalCount }
    }
  }
}`;

export const ISSUE_ACTIVITY_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(first: ${ISSUE_ACTIVITY_PAGE_SIZE}, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id author { login avatarUrl ... on User { name } } body createdAt url }
      }
    }
  }
}`;

/** The cheapest read that answers "may this account write here", asked before every mutation. */
export const ISSUE_PERMISSIONS_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { viewerCanUpdate locked }
  }
}`;

/**
 * The GitHub search that lists `is:issue` rows across a host's repositories, or null for a
 * repository selector GitHub cannot address — a name holding a space could end the `repo:`
 * qualifier and start one of its own, so an unaddressable one refuses the whole read.
 *
 * Every client-controlled value goes through the same escaping the pull-request search uses:
 * free text through `searchPhrase`, label and author values through `qualifierValue`.
 */
export function buildIssueSearchQuery(input: {
  readonly repositories: ReadonlyArray<string>;
  readonly state: IssueListState;
  readonly viewer: string;
  readonly query?: string | undefined;
  readonly filters?: IssueListFilters | undefined;
}): string | null {
  if (input.repositories.length === 0) return null;
  const repositories = input.repositories.map((repository) => repository.trim());
  if (!repositories.every((repository) => SEARCH_REPOSITORY.test(repository))) return null;
  const query = input.query?.trim() ?? "";
  const filters = input.filters;
  return [
    "is:issue",
    ...(input.state === "open" ? ["is:open"] : []),
    ...(input.state === "closed" ? ["is:closed"] : []),
    ...(query.length === 0 ? [] : [searchPhrase(query)]),
    // One qualifier per group, its names joined by commas — GitHub's own OR.
    ...(filters?.labels ?? []).flatMap((group) =>
      group.length === 0 ? [] : [`label:${group.map(qualifierValue).join(",")}`],
    ),
    ...(filters?.excludedLabels ?? []).map((label) => `-label:${qualifierValue(label)}`),
    ...(filters?.author === undefined
      ? []
      : [`author:${qualifierValue(resolvePullRequestAuthorFilter(filters.author, input.viewer))}`]),
    // The order the page reads its rows in, and the only order a continuation makes sense in.
    "sort:updated-desc",
    ...repositories.map((repository) => `repo:${repository}`),
  ].join(" ");
}

/**
 * What a continuation cursor may hold before it is handed to the host as a GraphQL variable.
 * GitHub's search cursors are short base64; anything else is a value this feed never issued.
 */
export const ISSUE_SEARCH_CURSOR = /^[A-Za-z0-9+/=_-]{1,512}$/;

const RawActorSchema = Schema.Struct({
  login: Schema.optional(Schema.String),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawSearchIssueSchema = Schema.Struct({
  number: Schema.optional(Schema.Int),
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  state: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  repository: Schema.optional(
    Schema.NullOr(Schema.Struct({ nameWithOwner: Schema.optional(Schema.String) })),
  ),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ nodes: Schema.optional(Schema.Array(Schema.NullOr(RawLabelSchema))) }),
    ),
  ),
  assignees: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ nodes: Schema.optional(Schema.Array(Schema.NullOr(RawActorSchema))) }),
    ),
  ),
  comments: Schema.optional(
    Schema.NullOr(Schema.Struct({ totalCount: Schema.optional(Schema.Int) })),
  ),
});

const RawSearchSchema = Schema.Struct({
  data: Schema.Struct({
    search: Schema.Struct({
      pageInfo: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            hasNextPage: Schema.optional(Schema.Boolean),
            endCursor: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
      nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
    }),
  }),
});

const decodeSearch = decodeJsonResult(RawSearchSchema);
const decodeSearchIssue = Schema.decodeUnknownExit(RawSearchIssueSchema);

function trimmed(value: string | null | undefined): string | null {
  const result = value?.trim() ?? "";
  return result.length === 0 ? null : result;
}

function toActor(raw: typeof RawActorSchema.Type | null | undefined): PullRequestActor | null {
  const login = trimmed(raw?.login);
  if (login === null) return null;
  return { login, name: trimmed(raw?.name), avatarUrl: trimmed(raw?.avatarUrl) };
}

function toActors(
  nodes: ReadonlyArray<typeof RawActorSchema.Type | null> | undefined,
): ReadonlyArray<PullRequestActor> {
  return (nodes ?? []).flatMap((node) => {
    const actor = toActor(node);
    return actor === null ? [] : [actor];
  });
}

function toLabels(
  nodes: ReadonlyArray<typeof RawLabelSchema.Type | null> | undefined,
): ReadonlyArray<PullRequestLabel> {
  return (nodes ?? []).flatMap((node) => {
    const name = trimmed(node?.name);
    return name === null ? [] : [{ name, color: trimmed(node?.color) }];
  });
}

/** GitHub answers `OPEN`/`CLOSED`; `gh issue list --json` answers the same words. */
function toIssueState(raw: string | null | undefined): IssueState | null {
  const state = raw?.trim().toLowerCase();
  return state === "open" || state === "closed" ? state : null;
}

export interface GitHubIssueSearchItem {
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly state: IssueState;
  readonly commentCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly assignees: ReadonlyArray<PullRequestActor>;
}

export interface GitHubIssueSearchBatch {
  readonly items: ReadonlyArray<GitHubIssueSearchItem>;
  /** Rows the search returned, counted before decoding, so a skipped row cannot hide a page. */
  readonly rawCount: number;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

/**
 * A search's rows flattened to neutral issue items. Rows that are not issues decode as empty
 * and are skipped, the way a malformed listing row is — `is:issue` already excludes them, and
 * one surprise must not blank a whole host.
 */
export function decodeIssueSearchJson(
  raw: string,
): Result.Result<GitHubIssueSearchBatch, DecodeFailure> {
  const decoded = decodeSearch(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const nodes = decoded.success.data.search.nodes ?? [];
  const items: GitHubIssueSearchItem[] = [];
  for (const entry of nodes) {
    const decodedNode = decodeSearchIssue(entry);
    if (!Exit.isSuccess(decodedNode)) continue;
    const node = decodedNode.value;
    const repository = trimmed(node.repository?.nameWithOwner);
    const title = trimmed(node.title);
    const url = trimmed(node.url);
    const state = toIssueState(node.state);
    const createdAt = trimmed(node.createdAt);
    const updatedAt = trimmed(node.updatedAt);
    if (
      repository === null ||
      node.number === undefined ||
      title === null ||
      url === null ||
      state === null ||
      createdAt === null ||
      updatedAt === null
    ) {
      continue;
    }
    items.push({
      repository,
      number: node.number,
      title,
      url,
      author: toActor(node.author),
      state,
      commentCount: Math.max(0, node.comments?.totalCount ?? 0),
      createdAt,
      updatedAt,
      labels: toLabels(node.labels?.nodes),
      assignees: toActors(node.assignees?.nodes),
    });
  }
  const pageInfo = decoded.success.data.search.pageInfo;
  return Result.succeed({
    items,
    rawCount: nodes.length,
    hasNextPage: pageInfo?.hasNextPage ?? false,
    endCursor: trimmed(pageInfo?.endCursor),
  });
}

const RawDetailSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        issue: Schema.NullOr(
          Schema.Struct({
            number: Schema.Int,
            title: Schema.String,
            body: Schema.optional(Schema.NullOr(Schema.String)),
            url: Schema.String,
            author: Schema.optional(Schema.NullOr(RawActorSchema)),
            state: Schema.String,
            locked: Schema.optional(Schema.Boolean),
            viewerCanUpdate: Schema.optional(Schema.Boolean),
            createdAt: Schema.String,
            updatedAt: Schema.String,
            closedAt: Schema.optional(Schema.NullOr(Schema.String)),
            labels: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  nodes: Schema.optional(Schema.Array(Schema.NullOr(RawLabelSchema))),
                }),
              ),
            ),
            assignees: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  nodes: Schema.optional(Schema.Array(Schema.NullOr(RawActorSchema))),
                }),
              ),
            ),
            comments: Schema.optional(
              Schema.NullOr(Schema.Struct({ totalCount: Schema.optional(Schema.Int) })),
            ),
          }),
        ),
      }),
    ),
  }),
});

const decodeDetail = decodeJsonResult(RawDetailSchema);

export interface GitHubIssueDetail {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly state: IssueState;
  readonly locked: boolean;
  readonly viewerCanUpdate: boolean;
  readonly commentCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly assignees: ReadonlyArray<PullRequestActor>;
}

/** Null where the repository or issue does not exist, which the caller reports as not found. */
export function decodeIssueDetailJson(
  raw: string,
): Result.Result<GitHubIssueDetail | null, DecodeFailure> {
  const decoded = decodeDetail(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const issue = decoded.success.data.repository?.issue ?? null;
  if (issue === null) return Result.succeed(null);
  const state = toIssueState(issue.state);
  if (state === null) return Result.succeed(null);
  return Result.succeed({
    number: issue.number,
    title: issue.title.trim(),
    body: issue.body ?? "",
    url: issue.url,
    author: toActor(issue.author),
    state,
    locked: issue.locked ?? false,
    viewerCanUpdate: issue.viewerCanUpdate ?? false,
    commentCount: Math.max(0, issue.comments?.totalCount ?? 0),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: trimmed(issue.closedAt),
    labels: toLabels(issue.labels?.nodes),
    assignees: toActors(issue.assignees?.nodes),
  });
}

const RawActivitySchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        issue: Schema.NullOr(
          Schema.Struct({
            comments: Schema.Struct({
              totalCount: Schema.optional(Schema.Int),
              pageInfo: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    hasNextPage: Schema.optional(Schema.Boolean),
                    endCursor: Schema.optional(Schema.NullOr(Schema.String)),
                  }),
                ),
              ),
              nodes: Schema.optional(
                Schema.NullOr(
                  Schema.Array(
                    Schema.NullOr(
                      Schema.Struct({
                        id: Schema.String,
                        author: Schema.optional(Schema.NullOr(RawActorSchema)),
                        body: Schema.optional(Schema.NullOr(Schema.String)),
                        createdAt: Schema.String,
                        url: Schema.optional(Schema.NullOr(Schema.String)),
                      }),
                    ),
                  ),
                ),
              ),
            }),
          }),
        ),
      }),
    ),
  }),
});

const decodeActivity = decodeJsonResult(RawActivitySchema);

export interface GitHubIssueActivityPage {
  readonly comments: ReadonlyArray<IssueComment>;
  readonly commentCount: number;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

/** Null where the repository or issue does not exist. */
export function decodeIssueActivityJson(
  raw: string,
): Result.Result<GitHubIssueActivityPage | null, DecodeFailure> {
  const decoded = decodeActivity(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const connection = decoded.success.data.repository?.issue?.comments ?? null;
  if (connection === null) return Result.succeed(null);
  const comments = (connection.nodes ?? []).flatMap((node): ReadonlyArray<IssueComment> => {
    const id = trimmed(node?.id);
    if (node === null || id === null) return [];
    return [
      {
        id,
        author: toActor(node.author),
        body: node.body ?? "",
        createdAt: node.createdAt,
        url: trimmed(node.url),
      },
    ];
  });
  return Result.succeed({
    comments,
    commentCount: Math.max(connection.totalCount ?? 0, comments.length),
    hasNextPage: connection.pageInfo?.hasNextPage ?? false,
    endCursor: trimmed(connection.pageInfo?.endCursor),
  });
}

const RawPermissionsSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        issue: Schema.NullOr(
          Schema.Struct({
            viewerCanUpdate: Schema.optional(Schema.Boolean),
            locked: Schema.optional(Schema.Boolean),
          }),
        ),
      }),
    ),
  }),
});

const decodePermissions = decodeJsonResult(RawPermissionsSchema);

export interface GitHubIssueViewerAccess {
  readonly canUpdate: boolean;
  readonly locked: boolean;
}

/** Null where the repository or issue does not exist. */
export function decodeIssuePermissionsJson(
  raw: string,
): Result.Result<GitHubIssueViewerAccess | null, DecodeFailure> {
  const decoded = decodePermissions(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const issue = decoded.success.data.repository?.issue ?? null;
  if (issue === null) return Result.succeed(null);
  return Result.succeed({
    canUpdate: issue.viewerCanUpdate ?? false,
    locked: issue.locked ?? false,
  });
}

/** The fields `gh issue list --json` is asked for on the search-free fallback read. */
export const ISSUE_LIST_JSON_FIELDS =
  "number,title,url,author,state,createdAt,updatedAt,labels,assignees";

const RawListItemSchema = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  labels: Schema.optional(Schema.NullOr(Schema.Array(RawLabelSchema))),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(RawActorSchema))),
});

const decodeList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeListItem = Schema.decodeUnknownExit(RawListItemSchema);

export interface GitHubIssueListItem {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly state: IssueState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly assignees: ReadonlyArray<PullRequestActor>;
}

export interface GitHubIssueListBatch {
  readonly items: ReadonlyArray<GitHubIssueListItem>;
  /** Rows in the raw answer, counted before decoding, so a skipped row cannot hide a page. */
  readonly rawCount: number;
}

/** `gh issue list --json` rows; a malformed row is skipped rather than blanking the listing. */
export function decodeIssueListJson(
  raw: string,
): Result.Result<GitHubIssueListBatch, DecodeFailure> {
  const decoded = decodeList(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const items: GitHubIssueListItem[] = [];
  for (const entry of decoded.success) {
    const decodedItem = decodeListItem(entry);
    if (!Exit.isSuccess(decodedItem)) continue;
    const item = decodedItem.value;
    const title = trimmed(item.title);
    const state = toIssueState(item.state);
    if (title === null || state === null) continue;
    items.push({
      number: item.number,
      title,
      url: item.url,
      author: toActor(item.author),
      state,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      labels: toLabels(item.labels ?? undefined),
      assignees: toActors(item.assignees ?? undefined),
    });
  }
  return Result.succeed({ items, rawCount: decoded.success.length });
}
