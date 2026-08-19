import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PullRequestActor, PullRequestLabel } from "./pullRequest.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

/**
 * The wire model for host-tracked issues. Issue-shaped rather than lead-shaped on purpose: a
 * Lead is an issue wearing the `lead` label, and the label filter below is how a client pins
 * that — nothing here knows the word.
 *
 * Actors and labels reuse the pull-request schemas because they are the same host objects; a
 * different shape here would be two names for one thing on the same wire.
 */

export const IssueState = Schema.Literals(["open", "closed"]);
export type IssueState = typeof IssueState.Type;

/** What a listing asks for: the two states an issue can be in, plus the option to span them. */
export const IssueListState = Schema.Literals(["all", "open", "closed"]);
export type IssueListState = typeof IssueListState.Type;

export const IssueAction = Schema.Literals(["close", "reopen"]);
export type IssueAction = typeof IssueAction.Type;

/** One qualifier's value, bounded because it is written into a host's own search query. */
const IssueQualifierValue = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const IssueQualifierValues = Schema.Array(IssueQualifierValue).check(Schema.isMaxLength(10));

/**
 * Narrowings beyond state, each absent by default — an absent field filters nothing. Labels
 * carry GitHub's own search semantics, the same as the pull-request filters: each group is one
 * `label:` qualifier, a row must satisfy every group, and a group holding several names is
 * satisfied by any one of them.
 */
export const IssueListFilters = Schema.Struct({
  labels: Schema.optional(Schema.Array(IssueQualifierValues).check(Schema.isMaxLength(10))),
  excludedLabels: Schema.optional(IssueQualifierValues),
  /** One login, as `author:` names it. */
  author: Schema.optional(IssueQualifierValue),
});
export type IssueListFilters = typeof IssueListFilters.Type;

export const IssueListEntry = Schema.Struct({
  provider: SourceControlProviderKind,
  /** The host below which `repository` is addressed, the account boundary rather than the kind. */
  host: TrimmedNonEmptyString,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: IssueState,
  /**
   * Absent where the read that produced this row could not count the conversation without
   * fetching it — the per-repository fallback read — which the page shows as nothing rather
   * than as zero.
   */
  commentCount: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  labels: Schema.Array(PullRequestLabel),
  assignees: Schema.Array(PullRequestActor),
});
export type IssueListEntry = typeof IssueListEntry.Type;

/**
 * Where each listing batch carries on from, keyed by the batch the service named in
 * `nextCursors`. Each value is opaque: only the server that issued one knows what it means, and
 * the page hands back exactly what it was given rather than composing one.
 */
export const IssueListCursors = Schema.Record(
  TrimmedNonEmptyString,
  // Bounded because it arrives from the page and is unfolded into a host request.
  TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
);
export type IssueListCursors = typeof IssueListCursors.Type;

export const IssueListInput = Schema.Struct({
  state: IssueListState,
  filters: Schema.optional(IssueListFilters),
  projectId: Schema.optional(ProjectId),
  /** Only these projects, for a client that assigns each shared repository to one connection. */
  projectIds: Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(100))),
  /** Narrows the listing to one host. Absent means every host the workspace has. */
  host: Schema.optional(TrimmedNonEmptyString),
  /** Rows to return per listing batch. */
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  /**
   * Carry on from an answer already on the page rather than read the listing again. Only the
   * batches named here are read, one slice each. Absent asks for the listing from the top.
   */
  cursors: Schema.optional(IssueListCursors),
  /** Free text the hosts themselves are asked to match. Bounded because it travels into a query. */
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type IssueListInput = typeof IssueListInput.Type;

/**
 * A host the workspace has projects on, and whether it can be read right now. The same shape
 * the pull-request page reports its hosts in, because it answers the same question.
 */
export const IssueProviderSummary = Schema.Struct({
  host: TrimmedNonEmptyString,
  kind: SourceControlProviderKind,
  projectCount: PositiveInt,
  /** False when the provider's CLI or credentials are missing, with `detail` saying which. */
  configured: Schema.Boolean,
  detail: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueProviderSummary = typeof IssueProviderSummary.Type;

/** One project whose repository could not be read; healthy projects still return entries. */
export const IssueListProjectError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type IssueListProjectError = typeof IssueListProjectError.Type;

export const IssueListResult = Schema.Struct({
  /** The signed-in account per host. A host that could not be read is absent. */
  viewers: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString),
  providers: Schema.Array(IssueProviderSummary),
  /** By update, newest first, across every batch this answer covers. */
  entries: Schema.Array(IssueListEntry),
  errors: Schema.Array(IssueListProjectError),
  /** At least one batch has more rows than this answer holds. */
  truncated: Schema.Boolean,
  /**
   * Where each batch carries on, to be sent straight back as `cursors`. A batch is absent from
   * this once it has nothing more to give.
   */
  nextCursors: IssueListCursors,
});
export type IssueListResult = typeof IssueListResult.Type;

export const IssueRef = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type IssueRef = typeof IssueRef.Type;

/** What a host can do with an issue at all, before the viewer's own access narrows it. */
export const IssueCapabilities = Schema.Struct({
  comment: Schema.Boolean,
  /** The actions this host can carry out; anything absent is never offered. */
  actions: Schema.Array(IssueAction),
  /** The host can narrow a listing by free text. */
  search: Schema.Boolean,
});
export type IssueCapabilities = typeof IssueCapabilities.Type;

/**
 * What the signed-in account may do with this issue, which is a different question from
 * `capabilities`: that says what the host can do at all, and this whether this viewer may ask.
 */
export const IssueViewerPermissions = Schema.Struct({
  /** Which of the actions this viewer may take; anything absent is theirs to look at only. */
  actions: Schema.Array(IssueAction),
  comment: Schema.Boolean,
});
export type IssueViewerPermissions = typeof IssueViewerPermissions.Type;

/**
 * The issue's own body and counts. Comments are deliberately not here: they arrive through the
 * separately paged activity read, so a long conversation cannot hold the body off screen or
 * put an unbounded array on the wire.
 */
export const IssueDetail = Schema.Struct({
  provider: SourceControlProviderKind,
  capabilities: IssueCapabilities,
  viewerPermissions: IssueViewerPermissions,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: IssueState,
  commentCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  labels: Schema.Array(PullRequestLabel),
  assignees: Schema.Array(PullRequestActor),
  /** Who the host says the reader is. Absent where the host could not say. */
  viewer: Schema.optional(TrimmedNonEmptyString),
});
export type IssueDetail = typeof IssueDetail.Type;

export const IssueComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  url: Schema.NullOr(Schema.String),
});
export type IssueComment = typeof IssueComment.Type;

export const IssueActivityInput = Schema.Struct({
  ...IssueRef.fields,
  /**
   * Where to carry on from. Absent asks for the first page. Opaque to the reader; bounded
   * because it arrives from the page and travels into a host request.
   */
  cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
});
export type IssueActivityInput = typeof IssueActivityInput.Type;

export const IssueActivity = Schema.Struct({
  comments: Schema.Array(IssueComment),
  /** The host's own count of the conversation, never less than `comments` holds. */
  commentCount: NonNegativeInt,
  /** This page stopped at a bound of its own before the host ran out. */
  commentsTruncated: Schema.Boolean,
  /** Where the next page starts, or null once the conversation is whole. */
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueActivity = typeof IssueActivity.Type;

// Not trimmed: the body is markdown, where leading spaces open a code block. GitHub rejects
// bodies past 65536 characters, so that bound is enforced here to keep oversized payloads off
// the wire; the service rejects a body that is only whitespace.
const IssueCommentBody = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536));

export const IssueCommentInput = Schema.Struct({
  ...IssueRef.fields,
  body: IssueCommentBody,
});
export type IssueCommentInput = typeof IssueCommentInput.Type;

export const IssueSetStateInput = Schema.Struct({
  ...IssueRef.fields,
  action: IssueAction,
});
export type IssueSetStateInput = typeof IssueSetStateInput.Type;

/**
 * Forget what the server has cached, so the next read asks the host. With a reference it
 * forgets that one issue's detail and activity; without one it forgets the listings. A separate
 * request rather than a flag on the reads, so only an explicit refresh spends host requests.
 */
export const IssueInvalidateInput = Schema.Struct({
  reference: Schema.optional(IssueRef),
});
export type IssueInvalidateInput = typeof IssueInvalidateInput.Type;

export const IssueUnavailableReason = Schema.Literals([
  "cli-missing",
  "cli-unauthenticated",
  "provider-unsupported",
]);
export type IssueUnavailableReason = typeof IssueUnavailableReason.Type;

/**
 * The feature is switched off entirely for a host. The message is derived from `reason` so it
 * stays a stable sentence the UI can show as-is; the underlying failure travels in `cause`.
 */
export class IssueUnavailableError extends Schema.TaggedErrorClass<IssueUnavailableError>()(
  "IssueUnavailableError",
  {
    reason: IssueUnavailableReason,
    provider: Schema.optional(SourceControlProviderKind),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "cli-missing":
        return "GitHub CLI (`gh`) is required to browse issues on this host. Install it from https://cli.github.com/ and reload.";
      case "cli-unauthenticated":
        return "GitHub CLI is not authenticated. Run `gh auth login` and retry.";
      case "provider-unsupported":
        return "Issues cannot be browsed for this project's host yet.";
    }
  }
}

export class IssueOperationError extends Schema.TaggedErrorClass<IssueOperationError>()(
  "IssueOperationError",
  {
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Issue operation ${this.operation} failed: ${this.detail}`;
  }
}
