import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  IssueAction,
  IssueCapabilities,
  IssueComment,
  IssueListFilters,
  IssueListState,
  IssueState,
  IssueViewerPermissions,
  PullRequestActor,
  PullRequestLabel,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { SourceControlProviderKind as SourceControlProviderKindSchema } from "@t3tools/contracts";

/**
 * The one failure shape every issue provider reports, so the service can decide what a failure
 * means without knowing which CLI or API produced it. Mirrors the pull-request port's error:
 * a missing or unauthenticated tool disables the provider for the whole workspace, a rate limit
 * pauses its host, and anything else is specific to the request.
 */
export class IssueProviderError extends Schema.TaggedErrorClass<IssueProviderError>()(
  "IssueProviderError",
  {
    provider: SourceControlProviderKindSchema,
    operation: Schema.String,
    reason: Schema.Literals(["missing-tool", "unauthenticated", "rate-limited", "failed"]),
    detail: Schema.String,
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

export interface IssueProviderFailure {
  readonly reason: IssueProviderError["reason"];
  readonly retryAt?: number | undefined;
}

/** An issue as the provider sees it, before the service attaches project context. */
export interface ProviderIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly state: IssueState;
  /** Absent where the read could not count the conversation without fetching it. */
  readonly commentCount?: number | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly assignees: ReadonlyArray<PullRequestActor>;
}

/** One repository's row inside an answer that spans several of them. */
export interface ProviderBatchedIssue extends ProviderIssue {
  /** Provider-native identity, exactly as it was asked for, so the caller can file the row. */
  readonly repository: string;
}

/**
 * One slice of a host read across several repositories at once, newest update first. The cursor
 * is the host's own continuation token for exactly this query — opaque to everyone else — so a
 * further slice can never skip or repeat rows however many of them share one update instant.
 */
export interface ProviderBatchedIssuePage {
  readonly items: ReadonlyArray<ProviderBatchedIssue>;
  /** Where the next slice starts, or null once the host has run out. */
  readonly nextCursor: string | null;
}

export interface ProviderIssuePage {
  readonly items: ReadonlyArray<ProviderIssue>;
  /** True when the host has more rows than the page size asked for. */
  readonly truncated: boolean;
}

export interface ProviderIssueDetail extends ProviderIssue {
  readonly body: string;
  readonly closedAt: string | null;
  readonly commentCount: number;
  readonly viewerPermissions: IssueViewerPermissions;
}

/** One page of the conversation, bounded by the provider's own page size. */
export interface ProviderIssueActivity {
  readonly comments: ReadonlyArray<IssueComment>;
  readonly commentCount: number;
  readonly commentsTruncated: boolean;
  readonly nextCursor: string | null;
}

export interface ProviderIssueRepositoryRef {
  readonly cwd: string;
  /** Provider-native repository identity, e.g. `owner/repo`. */
  readonly repository: string;
  /** The host it lives on, which `repository` deliberately leaves out. */
  readonly host: string;
}

/**
 * One host's issues. Implementations own their own tool and JSON shapes and hand back the
 * neutral types above; anything a host cannot do is declared in `capabilities` rather than
 * failing at call time.
 */
export interface IssueProviderApi {
  readonly kind: SourceControlProviderKind;
  readonly capabilities: IssueCapabilities;

  /** The signed-in account, which is also the "is this host set up" probe. */
  readonly getViewer: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string, IssueProviderError>;

  /**
   * The listing for a whole host in one search, carried on by the host's own opaque cursor.
   * The repositories named must stay identical for the life of a cursor chain: the cursor is
   * positional inside one query, and a different query makes it meaningless.
   */
  readonly listIssuesAcross: (input: {
    /** Any checkout on the host, which is what the tool is run in. */
    readonly cwd: string;
    readonly host: string;
    readonly repositories: ReadonlyArray<string>;
    readonly state: IssueListState;
    /** The signed-in login, which is what `author:me` resolves against. */
    readonly viewer: string;
    readonly limit: number;
    readonly query?: string | undefined;
    readonly cursor?: string | undefined;
    readonly filters?: IssueListFilters | undefined;
  }) => Effect.Effect<ProviderBatchedIssuePage, IssueProviderError>;

  /**
   * One repository asked on its own, first page only. The fallback for a repository the host's
   * search index does not cover, which answers a search with silence rather than an error.
   */
  readonly listIssues: (
    input: ProviderIssueRepositoryRef & {
      readonly state: IssueListState;
      readonly viewer: string;
      readonly limit: number;
      readonly filters?: IssueListFilters | undefined;
    },
  ) => Effect.Effect<ProviderIssuePage, IssueProviderError>;

  readonly getIssue: (
    input: ProviderIssueRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderIssueDetail, IssueProviderError>;

  readonly getIssueActivity: (
    input: ProviderIssueRepositoryRef & {
      readonly number: number;
      readonly cursor?: string | undefined;
    },
  ) => Effect.Effect<ProviderIssueActivity, IssueProviderError>;

  /**
   * Asked freshly before anything is written, so a request that reached the server without
   * going past the page is refused by what the host says rather than what the client claimed.
   */
  readonly getViewerPermissions: (
    input: ProviderIssueRepositoryRef & { readonly number: number },
  ) => Effect.Effect<IssueViewerPermissions, IssueProviderError>;

  readonly comment: (
    input: ProviderIssueRepositoryRef & { readonly number: number; readonly body: string },
  ) => Effect.Effect<void, IssueProviderError>;

  readonly setState: (
    input: ProviderIssueRepositoryRef & { readonly number: number; readonly action: IssueAction },
  ) => Effect.Effect<void, IssueProviderError>;
}
