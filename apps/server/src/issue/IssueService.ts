import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import {
  IssueOperationError,
  IssueUnavailableError,
  pullRequestHostOf,
  type IssueActivity,
  type IssueActivityInput,
  type IssueCommentInput,
  type IssueDetail,
  type IssueInvalidateInput,
  type IssueListEntry,
  type IssueListFilters,
  type IssueListInput,
  type IssueListProjectError,
  type IssueListResult,
  type IssueProviderSummary,
  type IssueRef,
  type IssueSetStateInput,
  type OrchestrationProjectShell,
  type SourceControlProviderKind,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import { makeStaleWhileRevalidate } from "../utils/staleWhileRevalidate.ts";
import { repositoryIdentityOf } from "../pullRequest/PullRequestService.ts";
import {
  IssueProviderError,
  type IssueProviderApi,
  type ProviderBatchedIssue,
} from "./IssueProvider.ts";
import { IssueProviderRegistry } from "./IssueProviderRegistry.ts";

/**
 * Rows per listing batch when the client does not ask for a page size. Exactly GitHub's ceiling
 * on a search page, and exactly a page: unlike the pull-request listing there is no probe row,
 * because the continuation is the host's own positional cursor and `hasNextPage` already says
 * whether there is more.
 */
const DEFAULT_LIST_LIMIT = 100;
/** Repositories named in one search, the bound the pull-request listing measured out. */
const REPOSITORY_SEARCH_CHUNK = 100;
/** Fallback reads run per repository; each spends its wall clock waiting on the host. */
const REPOSITORY_CONCURRENCY = 12;

// The same cache posture as the pull-request feature: short shared windows, epoch
// invalidation, and stale answers served while a fresh read runs behind them.
const LIST_CACHE_TTL = Duration.seconds(30);
const DETAIL_CACHE_TTL = Duration.seconds(15);
const LIST_STALE_WINDOW = Duration.minutes(10);
const DETAIL_STALE_WINDOW = Duration.minutes(5);
const VIEWER_CACHE_TTL = Duration.minutes(10);
const LIST_CACHE_CAPACITY = 64;
const DETAIL_CACHE_CAPACITY = 128;

type IssueError = IssueUnavailableError | IssueOperationError;

export class IssueService extends Context.Service<
  IssueService,
  {
    readonly list: (input: IssueListInput) => Effect.Effect<IssueListResult, IssueError>;
    readonly detail: (input: IssueRef) => Effect.Effect<IssueDetail, IssueError>;
    readonly activity: (input: IssueActivityInput) => Effect.Effect<IssueActivity, IssueError>;
    readonly comment: (input: IssueCommentInput) => Effect.Effect<void, IssueError>;
    readonly setState: (input: IssueSetStateInput) => Effect.Effect<void, IssueError>;
    readonly invalidate: (input: IssueInvalidateInput) => Effect.Effect<void>;
  }
>()("t3/issue/IssueService") {}

/** A project this feed can read: its remote is on a host with an implementation. */
interface SupportedProject {
  readonly project: OrchestrationProjectShell;
  readonly api: IssueProviderApi;
  readonly repository: string;
  readonly host: string;
}

interface WorkspaceProjects {
  readonly supported: ReadonlyArray<SupportedProject>;
  readonly unimplemented: ReadonlyMap<
    string,
    { readonly kind: SourceControlProviderKind; readonly projectCount: number }
  >;
  /** Every checkout on a host, so one broken worktree cannot take the host's viewer down. */
  readonly viewerRoots: ReadonlyMap<string, ReadonlyArray<string>>;
}

/** How a listing tells two repositories apart: the same `owner/repo` on two hosts is two. */
function repositoryKey(host: string, repository: string): string {
  return `${host} ${repository.toLowerCase()}`;
}

/**
 * A short stable fingerprint of a batch's membership. The continuation cursor is positional
 * inside one exact search, so a batch whose repositories have changed since the cursor was
 * issued must be refused rather than resumed — this is what detects that.
 */
function batchFingerprint(repositories: ReadonlyArray<string>): string {
  let hash = 5381;
  for (const character of repositories.join("\n")) {
    hash = ((hash * 33) ^ character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16);
}

/**
 * A continuation as it travels through the page and back: a version tag, the membership
 * fingerprint, and the host's own opaque cursor. Written out rather than encoded because it
 * comes back from a client and has to be believed or refused on sight.
 */
const LIST_CURSOR_PATTERN = /^v1\|([0-9a-f]{1,16})\|([A-Za-z0-9+/=_-]{1,512})$/;

interface BatchCursor {
  readonly fingerprint: string;
  readonly after: string;
}

function parseBatchCursor(raw: string): BatchCursor | null {
  const match = LIST_CURSOR_PATTERN.exec(raw);
  if (match === null) return null;
  return { fingerprint: match[1]!, after: match[2]! };
}

function formatBatchCursor(fingerprint: string, after: string): string {
  return `v1|${fingerprint}|${after}`;
}

/** A host that cannot be read at all, as opposed to one request that failed. */
function isProviderUnusable(error: IssueProviderError): boolean {
  return error.reason === "missing-tool" || error.reason === "unauthenticated";
}

/** Why a host is not readable, told as the thing to do about it rather than the symptom. */
function providerDetail(error: IssueProviderError): string {
  if (!isProviderUnusable(error)) return error.detail;
  return new IssueUnavailableError({
    reason: error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
    provider: error.provider,
  }).message;
}

function toUnavailableError(error: IssueProviderError): IssueUnavailableError {
  return new IssueUnavailableError({
    reason: error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
    provider: error.provider,
    cause: error,
  });
}

function toIssueError(operation: string): (error: IssueProviderError) => IssueError {
  return (error) =>
    isProviderUnusable(error)
      ? toUnavailableError(error)
      : new IssueOperationError({ operation, detail: error.detail, cause: error });
}

const ACTION_ACCESS_REFUSALS = {
  close: "You need write access on this repository, or to have opened this issue, to close it.",
  reopen: "You need write access on this repository, or to have opened this issue, to reopen it.",
} as const;

/**
 * Every provider call goes through the shared per-host cooldown, so a rate-limited host pauses
 * this feature and the pull-request page together. Mutation-guarding reads are `interactive`:
 * they may run against a paused host, because refusing them refuses the person mid-action.
 */
function withRateLimitBackoff(
  api: IssueProviderApi,
  host: string,
  limits: SourceControlRateLimit.SourceControlRateLimit["Service"],
): IssueProviderApi {
  const key = { provider: api.kind, host };
  const protect = <A>(
    operation: string,
    effect: Effect.Effect<A, IssueProviderError>,
    allowPaused: boolean,
  ) =>
    limits.check(key, allowPaused ? { allowPaused: true } : undefined).pipe(
      Effect.mapError(
        (error) =>
          new IssueProviderError({
            provider: api.kind,
            operation,
            reason: "rate-limited",
            detail: error.detail,
            retryAt: error.retryAt,
            cause: error,
          }),
      ),
      Effect.flatMap((lease) =>
        effect.pipe(
          Effect.tap(() => limits.recordSuccess({ ...key, lease })),
          Effect.tapError((error) =>
            error.reason === "rate-limited"
              ? limits.recordRateLimit({
                  ...key,
                  lease,
                  ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
                })
              : Effect.void,
          ),
        ),
      ),
    );
  const wrap =
    <Args extends ReadonlyArray<unknown>, A>(
      operation: string,
      call: (...args: Args) => Effect.Effect<A, IssueProviderError>,
      allowPaused = false,
    ) =>
    (...args: Args) =>
      protect(operation, call(...args), allowPaused);
  const interactive = <Args extends ReadonlyArray<unknown>, A>(
    operation: string,
    call: (...args: Args) => Effect.Effect<A, IssueProviderError>,
  ) => wrap(operation, call, true);

  return {
    kind: api.kind,
    capabilities: api.capabilities,
    getViewer: wrap("getViewer", api.getViewer),
    listIssuesAcross: wrap("listIssuesAcross", api.listIssuesAcross),
    listIssues: wrap("listIssues", api.listIssues),
    getIssue: wrap("getIssue", api.getIssue),
    getIssueActivity: wrap("getIssueActivity", api.getIssueActivity),
    getViewerPermissions: interactive("getViewerPermissions", api.getViewerPermissions),
    comment: interactive("comment", api.comment),
    setState: interactive("setState", api.setState),
  };
}

export const make = Effect.gen(function* () {
  const registry = yield* IssueProviderRegistry;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const rateLimits = yield* SourceControlRateLimit.SourceControlRateLimit;

  const listWorkspaceProjects = (
    filter: Pick<IssueListInput, "projectId" | "projectIds" | "host">,
  ): Effect.Effect<WorkspaceProjects, IssueError> =>
    projections.getShellSnapshot().pipe(
      Effect.mapError(
        (error) =>
          new IssueOperationError({
            operation: "listProjects",
            detail: "The project list could not be read.",
            cause: error,
          }),
      ),
      Effect.map((snapshot) => {
        const supported: SupportedProject[] = [];
        const unimplemented = new Map<
          string,
          { kind: SourceControlProviderKind; projectCount: number }
        >();
        const viewerRoots = new Map<string, string[]>();
        const seen = new Set<string>();
        for (const project of snapshot.projects) {
          if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
          if (filter.projectIds !== undefined && !filter.projectIds.includes(project.id)) continue;
          const identity = project.repositoryIdentity;
          const kind = identity?.provider as SourceControlProviderKind | undefined;
          const repository = repositoryIdentityOf(project);
          if (!identity || kind === undefined || repository === null) continue;
          const host = pullRequestHostOf(identity, kind);
          if (filter.host !== undefined && host !== filter.host.toLowerCase()) continue;
          const api = registry.get(kind);
          if (api !== null) {
            const roots = viewerRoots.get(host);
            if (roots === undefined) viewerRoots.set(host, [project.workspaceRoot]);
            else if (!roots.includes(project.workspaceRoot)) roots.push(project.workspaceRoot);
          }
          // Worktrees of one repository are separate projects; reading the remote once keeps
          // the page from repeating every issue per local checkout.
          const key = repositoryKey(host, repository);
          if (seen.has(key)) continue;
          seen.add(key);
          if (api === null) {
            const counted = unimplemented.get(host);
            if (counted === undefined) unimplemented.set(host, { kind, projectCount: 1 });
            else counted.projectCount += 1;
            continue;
          }
          supported.push({
            project,
            api: withRateLimitBackoff(api, host, rateLimits),
            repository,
            host,
          });
        }
        return { supported, unimplemented, viewerRoots };
      }),
    );

  const requireProject = (ref: IssueRef): Effect.Effect<SupportedProject, IssueError> =>
    listWorkspaceProjects({ projectId: ref.projectId }).pipe(
      Effect.flatMap(({ supported }): Effect.Effect<SupportedProject, IssueError> => {
        const match = supported[0];
        if (!match) {
          return Effect.fail(new IssueUnavailableError({ reason: "provider-unsupported" }));
        }
        // The repository travels through the client, so it is checked against the project's
        // own remote rather than being handed to a provider verbatim.
        if (match.repository.toLowerCase() !== ref.repository.trim().toLowerCase()) {
          return Effect.fail(
            new IssueOperationError({
              operation: "resolveRepository",
              detail: "The issue does not belong to the selected project.",
            }),
          );
        }
        return Effect.succeed(match);
      }),
    );

  // Who is signed in moves on the timescale of `gh auth login`, not of a page visit. Only a
  // success is believed for a while: a failure is the "is this host set up" answer, and
  // holding it would keep saying signed-out after the reader has signed in.
  type ResolvedViewer = {
    readonly host: string;
    readonly kind: SourceControlProviderKind;
    readonly viewer: string | null;
    readonly error: IssueProviderError | null;
  };
  const viewersByHost = new Map<string, { readonly at: number; readonly result: ResolvedViewer }>();

  const resolveViewers = (
    projects: ReadonlyArray<SupportedProject>,
    viewerRoots: WorkspaceProjects["viewerRoots"],
  ) =>
    Effect.forEach(
      [...new Set(projects.map(({ host }) => host))],
      (host) =>
        Effect.flatMap(Clock.currentTimeMillis, (now): Effect.Effect<ResolvedViewer> => {
          const held = viewersByHost.get(host);
          if (held !== undefined && now - held.at <= Duration.toMillis(VIEWER_CACHE_TTL)) {
            return Effect.succeed(held.result);
          }
          const forHost = projects.filter((project) => project.host === host);
          const api = forHost[0]!.api;
          const roots =
            viewerRoots.get(host) ?? forHost.map(({ project }) => project.workspaceRoot);
          return Effect.firstSuccessOf(roots.map((cwd) => api.getViewer({ cwd }))).pipe(
            Effect.map((viewer) => ({
              host,
              kind: api.kind,
              viewer: viewer as string | null,
              error: null as IssueProviderError | null,
            })),
            Effect.tap((result) =>
              Effect.map(Clock.currentTimeMillis, (at) => viewersByHost.set(host, { at, result })),
            ),
            Effect.catch((error) => Effect.succeed({ host, kind: api.kind, viewer: null, error })),
          );
        }),
      { concurrency: REPOSITORY_CONCURRENCY },
    );

  const toEntry = (project: SupportedProject, item: ProviderBatchedIssue): IssueListEntry => ({
    provider: project.api.kind,
    host: project.host,
    projectId: project.project.id,
    projectTitle: project.project.title,
    repository: project.repository,
    number: item.number,
    title: item.title,
    url: item.url,
    author: item.author,
    state: item.state,
    ...(item.commentCount === undefined ? {} : { commentCount: item.commentCount }),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    labels: item.labels,
    assignees: item.assignees,
  });

  /** One listing batch: a host's repositories read in one search, or one fallback read. */
  interface ListBatch {
    readonly key: string;
    readonly entries: ReadonlyArray<IssueListEntry>;
    readonly errors: ReadonlyArray<IssueListProjectError>;
    readonly nextCursor: string | null;
  }

  const listUncached: IssueService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const {
        supported: projects,
        unimplemented,
        viewerRoots,
      } = yield* listWorkspaceProjects(input);
      const projectCounts = new Map<string, number>();
      for (const { host } of projects) {
        projectCounts.set(host, (projectCounts.get(host) ?? 0) + 1);
      }

      const viewerResults = yield* resolveViewers(projects, viewerRoots);
      const viewers: Record<string, string> = {};
      for (const result of viewerResults) {
        if (result.viewer !== null) viewers[result.host] = result.viewer;
      }

      const providers: ReadonlyArray<IssueProviderSummary> = [
        ...viewerResults.map((result) => ({
          host: result.host,
          kind: result.kind,
          projectCount: projectCounts.get(result.host) ?? 1,
          configured: result.viewer !== null,
          detail: result.error === null ? null : providerDetail(result.error),
        })),
        ...[...unimplemented].map(([host, { kind, projectCount }]) => ({
          host,
          kind,
          projectCount,
          configured: false,
          detail: "This host cannot be browsed here yet.",
        })),
      ];

      // Batches are deterministic: each host's repositories sorted, then chunked. Membership
      // is what the cursor's fingerprint is checked against, so a continuation of a changed
      // workspace is refused rather than quietly skipping rows.
      const byHost = new Map<string, SupportedProject[]>();
      for (const project of projects) {
        const held = byHost.get(project.host);
        if (held === undefined) byHost.set(project.host, [project]);
        else held.push(project);
      }
      interface Batch {
        readonly key: string;
        readonly host: string;
        readonly members: ReadonlyArray<SupportedProject>;
        readonly fingerprint: string;
      }
      const batches: Batch[] = [];
      for (const [host, members] of [...byHost].toSorted(([left], [right]) =>
        left.localeCompare(right),
      )) {
        const sorted = members.toSorted((left, right) =>
          left.repository.toLowerCase().localeCompare(right.repository.toLowerCase()),
        );
        for (let start = 0; start < sorted.length; start += REPOSITORY_SEARCH_CHUNK) {
          const chunk = sorted.slice(start, start + REPOSITORY_SEARCH_CHUNK);
          batches.push({
            key: `${host} #${start / REPOSITORY_SEARCH_CHUNK}`,
            host,
            members: chunk,
            fingerprint: batchFingerprint(chunk.map((member) => member.repository.toLowerCase())),
          });
        }
      }

      // A cursor is only ever a value this service issued, so one that does not read as one —
      // or names a batch whose membership has moved — means the listing cannot be carried on;
      // reading part of it under that assumption would quietly lose rows.
      const continuation = new Map<string, BatchCursor>();
      if (input.cursors !== undefined) {
        for (const [key, raw] of Object.entries(input.cursors)) {
          const cursor = parseBatchCursor(raw);
          const batch = batches.find((candidate) => candidate.key === key);
          if (cursor === null || batch === undefined || batch.fingerprint !== cursor.fingerprint) {
            return yield* new IssueOperationError({
              operation: "list",
              detail: "The list could not be carried on from where it left off.",
            });
          }
          continuation.set(key, cursor);
        }
      }

      // A continued listing reads only the batches it was asked to carry on with; everything
      // else is already on the page. The host summaries above stay over the whole workspace.
      const selected =
        input.cursors === undefined
          ? batches
          : batches.filter((batch) => continuation.has(batch.key));
      const readable = selected.filter((batch) => viewers[batch.host] !== undefined);
      const unreadable = selected
        .filter((batch) => viewers[batch.host] === undefined)
        .flatMap((batch) =>
          batch.members.map(({ project, repository }) => ({
            projectId: project.id,
            projectTitle: project.title,
            message: `${repository} could not be read.`,
          })),
        );
      if (readable.length === 0) {
        const errors = viewerResults.flatMap((result) =>
          result.error === null || !selected.some((batch) => batch.host === result.host)
            ? []
            : [result.error],
        );
        const blocking = errors.find(isProviderUnusable) ?? errors[0];
        if (blocking) {
          return yield* toIssueError("list")(blocking);
        }
        return {
          viewers: viewers as IssueListResult["viewers"],
          providers,
          entries: [],
          errors: unreadable,
          truncated: false,
          nextCursors: {},
        };
      }

      const limit = input.limit ?? DEFAULT_LIST_LIMIT;
      // One budget across the batch reads and their nested fallbacks: each read is a `gh`
      // process, and two fan-out levels at the same concurrency would multiply — worst on the
      // degraded paths, which run exactly when a host is already slow or rate-limited.
      const readSlots = yield* Semaphore.make(REPOSITORY_CONCURRENCY);

      /** The fallback for a repository the host's search index answers with silence. */
      const readRepositoryAlone = (project: SupportedProject): Effect.Effect<ListBatch> =>
        readSlots
          .withPermits(1)(
            project.api.listIssues({
              cwd: project.project.workspaceRoot,
              repository: project.repository,
              host: project.host,
              state: input.state,
              viewer: viewers[project.host]!,
              limit,
              filters: input.filters,
            }),
          )
          .pipe(
            Effect.map(
              (page): ListBatch => ({
                key: repositoryKey(project.host, project.repository),
                entries: page.items.map((item) =>
                  toEntry(project, { ...item, repository: project.repository }),
                ),
                errors: [],
                // A fallback page cannot be carried on from: the list API answers in an order
                // no search cursor can express, so more rows are reached by a larger limit.
                nextCursor: null,
              }),
            ),
            // One unreachable repository must not blank the page, and its error row carries
            // the actionable reason rather than a generic sentence.
            Effect.catch(
              (error): Effect.Effect<ListBatch> =>
                Effect.succeed({
                  key: repositoryKey(project.host, project.repository),
                  entries: [],
                  errors: [
                    {
                      projectId: project.project.id,
                      projectTitle: project.project.title,
                      message: `${project.repository} could not be read: ${providerDetail(error)}`,
                    },
                  ],
                  nextCursor: null,
                }),
            ),
          );

      const readBatch = (batch: Batch): Effect.Effect<ReadonlyArray<ListBatch>> => {
        const viewer = viewers[batch.host]!;
        const first = batch.members[0]!;
        const cursor = continuation.get(batch.key);
        const byRepository = new Map(
          batch.members.map((member) => [member.repository.toLowerCase(), member]),
        );
        return readSlots
          .withPermits(1)(
            first.api.listIssuesAcross({
              cwd: first.project.workspaceRoot,
              host: batch.host,
              repositories: batch.members.map((member) => member.repository),
              state: input.state,
              viewer,
              limit,
              query: input.query,
              filters: input.filters,
              ...(cursor === undefined ? {} : { cursor: cursor.after }),
            }),
          )
          .pipe(
            Effect.flatMap((page) => {
              const rows = new Map<string, ProviderBatchedIssue[]>();
              for (const item of page.items) {
                const key = item.repository.trim().toLowerCase();
                const held = rows.get(key);
                if (held === undefined) rows.set(key, [item]);
                else held.push(item);
              }
              const searched: ListBatch = {
                key: batch.key,
                entries: [...rows].flatMap(([key, items]) => {
                  const member = byRepository.get(key);
                  return member === undefined ? [] : items.map((item) => toEntry(member, item));
                }),
                errors: [],
                nextCursor:
                  page.nextCursor === null
                    ? null
                    : formatBatchCursor(batch.fingerprint, page.nextCursor),
              };
              // GitHub does not index every repository for search — a renamed one answers for
              // its old name with silence rather than an error — so a repository the search
              // said nothing about is read on its own, once, before it is believed. Only on
              // the first slice: past one, silence means its rows are older, not absent. A
              // free-text query rules the fallback out: an empty answer under one is already
              // the answer, and the list API cannot search text.
              const silent =
                cursor !== undefined || (input.query?.trim().length ?? 0) > 0
                  ? []
                  : batch.members.filter((member) => !rows.has(member.repository.toLowerCase()));
              // Unbounded because `readSlots` is the bound; the same holds below.
              return Effect.forEach(silent, readRepositoryAlone, {
                concurrency: "unbounded",
              }).pipe(Effect.map((alone) => [searched, ...alone]));
            }),
            Effect.catch((error) =>
              // An unusable or paused host would refuse every per-repository read the same
              // way, so those errors skip the fallback and carry their actionable reason into
              // the rows instead of N copies of a generic failure. An ordinary failure still
              // degrades to a read per repository rather than a blank host.
              error.reason !== "failed"
                ? Effect.succeed(
                    batch.members.map(
                      (member): ListBatch => ({
                        key: repositoryKey(member.host, member.repository),
                        entries: [],
                        errors: [
                          {
                            projectId: member.project.id,
                            projectTitle: member.project.title,
                            message: `${member.repository} could not be read: ${providerDetail(error)}`,
                          },
                        ],
                        nextCursor: null,
                      }),
                    ),
                  )
                : Effect.forEach(batch.members, readRepositoryAlone, {
                    concurrency: "unbounded",
                  }),
            ),
          );
      };

      const results = (yield* Effect.forEach(readable, readBatch, {
        concurrency: "unbounded",
      })).flat();

      const nextCursors: Record<string, string> = {};
      for (const result of results) {
        if (result.nextCursor !== null) nextCursors[result.key] = result.nextCursor;
      }

      return {
        viewers: viewers as IssueListResult["viewers"],
        providers,
        entries: results
          .flatMap((result) => result.entries)
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
        errors: [...unreadable, ...results.flatMap((result) => result.errors)],
        truncated: results.some((result) => result.nextCursor !== null),
        nextCursors,
      };
    });

  /** Who this project's host says the reader is, shared with the listing's ten-minute answer. */
  const viewerOf = (project: SupportedProject): Effect.Effect<string | null> =>
    resolveViewers([project], new Map()).pipe(Effect.map(([resolved]) => resolved?.viewer ?? null));

  const detailUncached: IssueService["Service"]["detail"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        Effect.all(
          [
            project.api
              .getIssue({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
              })
              .pipe(Effect.mapError(toIssueError("detail"))),
            viewerOf(project),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(
            ([issue, viewer]): IssueDetail => ({
              provider: project.api.kind,
              capabilities: project.api.capabilities,
              viewerPermissions: issue.viewerPermissions,
              projectId: project.project.id,
              projectTitle: project.project.title,
              workspaceRoot: project.project.workspaceRoot,
              repository: project.repository,
              number: issue.number,
              title: issue.title,
              body: issue.body,
              url: issue.url,
              author: issue.author,
              state: issue.state,
              commentCount: issue.commentCount,
              createdAt: issue.createdAt,
              updatedAt: issue.updatedAt,
              closedAt: issue.closedAt,
              labels: issue.labels,
              assignees: issue.assignees,
              ...(viewer === null || viewer.trim().length === 0 ? {} : { viewer }),
            }),
          ),
        ),
      ),
    );

  const activityUncached: IssueService["Service"]["activity"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api
          .getIssueActivity({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          })
          .pipe(
            Effect.mapError(toIssueError("activity")),
            Effect.map(
              (page): IssueActivity => ({
                comments: page.comments,
                commentCount: page.commentCount,
                commentsTruncated: page.commentsTruncated,
                nextCursor: page.nextCursor,
              }),
            ),
          ),
      ),
    );

  /**
   * What the signed-in account may do, asked of the host itself immediately before every write:
   * a request that arrived without passing through the page — or after the access behind it was
   * withdrawn — must not be handed to a provider on the client's word.
   */
  const viewerPermissionsOf = (project: SupportedProject, ref: IssueRef, operation: string) =>
    project.api
      .getViewerPermissions({
        cwd: project.project.workspaceRoot,
        repository: project.repository,
        host: project.host,
        number: ref.number,
      })
      .pipe(Effect.mapError(toIssueError(operation)));

  const comment: IssueService["Service"]["comment"] = (input) =>
    // The contract keeps the body verbatim because it is markdown, so the "did the user
    // actually write something" check lives here.
    (input.body.trim().length === 0
      ? Effect.fail(
          new IssueOperationError({ operation: "comment", detail: "A comment cannot be empty." }),
        )
      : requireProject(input)
    ).pipe(
      Effect.flatMap((project): Effect.Effect<void, IssueError> => {
        if (!project.api.capabilities.comment) {
          return Effect.fail(
            new IssueOperationError({
              operation: "comment",
              detail: "This host cannot post a comment on an issue.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "comment").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, IssueError> => {
            if (!viewer.comment) {
              return Effect.fail(
                new IssueOperationError({
                  operation: "comment",
                  detail: "This conversation does not accept comments from this account.",
                }),
              );
            }
            return project.api
              .comment({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                body: input.body,
              })
              .pipe(Effect.mapError(toIssueError("comment")));
          }),
        );
      }),
    );

  const setState: IssueService["Service"]["setState"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, IssueError> => {
        // The surface hides what a host cannot do, and this refuses it as well.
        if (!project.api.capabilities.actions.includes(input.action)) {
          return Effect.fail(
            new IssueOperationError({
              operation: "setState",
              detail: `This host cannot ${input.action} an issue.`,
            }),
          );
        }
        return viewerPermissionsOf(project, input, "setState").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, IssueError> => {
            if (!viewer.actions.includes(input.action)) {
              return Effect.fail(
                new IssueOperationError({
                  operation: "setState",
                  detail: ACTION_ACCESS_REFUSALS[input.action],
                }),
              );
            }
            return project.api
              .setState({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                action: input.action,
              })
              .pipe(Effect.mapError(toIssueError("setState")));
          }),
        );
      }),
    );

  const staleWhileRevalidate = yield* makeStaleWhileRevalidate;

  // Epochs are the invalidation mechanism: a key carries its scope's epoch, so bumping the
  // epoch strands every entry made under the old one. Shared and monotonic so a scope
  // re-entering after eviction can never mint a key an old entry still has.
  let epochCounter = 0;
  let listingsEpoch = 0;
  // Every scope absent from the map reads this floor. Evicting a scope raises it past the
  // evicted epoch, so the scope can never fall back onto an epoch a live cache entry still
  // holds — dropping to a plain 0 would resurrect entries keyed before its mutations.
  let refEpochFloor = 0;
  const refEpochs = new Map<string, number>();
  const REF_EPOCH_CAPACITY = 2_048;
  const refScope = (ref: IssueRef) => `${ref.projectId} ${ref.repository} ${ref.number}`;
  const refEpoch = (ref: IssueRef) => refEpochs.get(refScope(ref)) ?? refEpochFloor;
  const bumpRefEpoch = (ref: IssueRef) => {
    const scope = refScope(ref);
    if (!refEpochs.has(scope) && refEpochs.size >= REF_EPOCH_CAPACITY) {
      const oldest = refEpochs.keys().next().value;
      if (oldest !== undefined) {
        refEpochs.delete(oldest);
        refEpochFloor = ++epochCounter;
      }
    }
    refEpochs.set(scope, ++epochCounter);
  };

  const filtersOfKey = (
    slots: ReadonlyArray<
      string | ReadonlyArray<string> | ReadonlyArray<ReadonlyArray<string>> | null
    >,
  ): IssueListFilters => {
    const [labels, excludedLabels, author] = slots;
    return {
      ...(Array.isArray(labels) ? { labels: labels as ReadonlyArray<ReadonlyArray<string>> } : {}),
      ...(Array.isArray(excludedLabels)
        ? { excludedLabels: excludedLabels as ReadonlyArray<string> }
        : {}),
      ...(typeof author === "string" ? { author } : {}),
    };
  };

  // Keys serialize positionally and parse back in the lookup, so the cache is the only holder
  // of in-flight state: concurrent identical reads coalesce on the key into one host request.
  const listCache = yield* Cache.makeWith(
    (key: string) => {
      const [, state, filters, projectId, projectIds, host, limit, query, cursorEntries] =
        JSON.parse(key) as [
          number,
          string,
          ReadonlyArray<string | ReadonlyArray<string> | null> | null,
          string | null,
          ReadonlyArray<string> | null,
          string | null,
          number | null,
          string | null,
          ReadonlyArray<[string, string]> | null,
        ];
      return listUncached({
        state,
        ...(filters === null ? {} : { filters: filtersOfKey(filters) }),
        ...(projectId === null ? {} : { projectId }),
        ...(projectIds === null ? {} : { projectIds }),
        ...(host === null ? {} : { host }),
        ...(limit === null ? {} : { limit }),
        ...(query === null ? {} : { query }),
        ...(cursorEntries === null ? {} : { cursors: Object.fromEntries(cursorEntries) }),
      } as IssueListInput);
    },
    {
      capacity: LIST_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_CACHE_TTL : Duration.zero),
    },
  );
  const staleList = staleWhileRevalidate<IssueListResult>(LIST_STALE_WINDOW, LIST_CACHE_CAPACITY);
  const list: IssueService["Service"]["list"] = (input) => {
    const key = JSON.stringify([
      listingsEpoch,
      input.state,
      input.filters === undefined
        ? null
        : [
            input.filters.labels ?? null,
            input.filters.excludedLabels ?? null,
            input.filters.author ?? null,
          ],
      input.projectId ?? null,
      input.projectIds === undefined ? null : [...input.projectIds].sort(),
      input.host ?? null,
      input.limit ?? null,
      input.query ?? null,
      input.cursors === undefined
        ? null
        : Object.entries(input.cursors).toSorted(([left], [right]) => left.localeCompare(right)),
    ]);
    return staleList(key, Cache.get(listCache, key));
  };

  const detailCache = yield* Cache.makeWith(
    (key: string) => {
      const [, projectId, repository, number] = JSON.parse(key) as [number, string, string, number];
      return detailUncached({ projectId, repository, number } as IssueRef);
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? DETAIL_CACHE_TTL : Duration.zero),
    },
  );
  const staleDetail = staleWhileRevalidate<IssueDetail>(DETAIL_STALE_WINDOW, DETAIL_CACHE_CAPACITY);
  const detail: IssueService["Service"]["detail"] = (input) => {
    const key = JSON.stringify([refEpoch(input), input.projectId, input.repository, input.number]);
    return staleDetail(key, Cache.get(detailCache, key));
  };

  const activityCache = yield* Cache.makeWith(
    (key: string) => {
      const [, projectId, repository, number, cursor] = JSON.parse(key) as [
        number,
        string,
        string,
        number,
        string | null,
      ];
      return activityUncached({
        projectId,
        repository,
        number,
        ...(cursor === null ? {} : { cursor }),
      } as IssueActivityInput);
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? DETAIL_CACHE_TTL : Duration.zero),
    },
  );
  const staleActivity = staleWhileRevalidate<IssueActivity>(
    DETAIL_STALE_WINDOW,
    DETAIL_CACHE_CAPACITY,
  );
  const activity: IssueService["Service"]["activity"] = (input) => {
    const key = JSON.stringify([
      refEpoch(input),
      input.projectId,
      input.repository,
      input.number,
      input.cursor ?? null,
    ]);
    return staleActivity(key, Cache.get(activityCache, key));
  };

  const invalidate: IssueService["Service"]["invalidate"] = (input) =>
    Effect.sync(() => {
      if (input.reference === undefined) {
        listingsEpoch = ++epochCounter;
        viewersByHost.clear();
        return;
      }
      bumpRefEpoch(input.reference);
    });

  // A mutation's own client re-reads right after it, and every other client's next read must
  // see the action too. Comments get no discount: a comment moves the issue's activity, its
  // detail counts, and the list row's updated-time ordering, so every write forgets all three.
  const invalidatedByMutation =
    <I extends IssueRef>(
      method: (input: I) => Effect.Effect<void, IssueError>,
    ): ((input: I) => Effect.Effect<void, IssueError>) =>
    (input) =>
      method(input).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            bumpRefEpoch(input);
            listingsEpoch = ++epochCounter;
          }),
        ),
      );

  return IssueService.of({
    list,
    detail,
    activity,
    comment: invalidatedByMutation(comment),
    setState: invalidatedByMutation(setState),
    invalidate,
  });
});

export const layer = Layer.effect(IssueService, make);
