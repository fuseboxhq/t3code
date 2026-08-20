import type {
  EnvironmentId,
  IssueListInput,
  ProjectId,
  PullRequestListInput,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";

import {
  LEAD_LIST_PAGE_SIZE,
  buildLeadListFilters,
  parseLeadQuery,
  type MergedIssueList,
} from "../components/leads/leadsList.logic";
import {
  PULL_REQUEST_LIST_PAGE_SIZE,
  type MergedPullRequestList,
} from "../components/pullRequest/pullRequestList.logic";
import {
  assignEnvironmentProjectQueries,
  type AssignableProject,
} from "../components/pullRequest/pullRequestProjectAssignment.logic";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "./entities";
import { useEnvironments } from "./environments";
import { useIssueList } from "./issues";
import { usePullRequestList, type EnvironmentQueryTarget } from "./pullRequests";

/**
 * One repository's open work, plus whether each number is exact or the floor of a listing that
 * had more to give. A truncated feed's rows are a first page, not a census, and a badge that
 * says "3" when the host holds five is lying with precision.
 */
export interface ProjectActivityCounts {
  readonly pullRequests: number;
  readonly pullRequestsAtLeast: boolean;
  readonly leads: number;
  readonly leadsAtLeast: boolean;
}

/**
 * The feeds' rows folded into counts per repository. Keyed by repository rather than by project
 * because the hosts' work is repository-level: the feeds attribute each row to the one project
 * their listing picked for its repository, and a second project holding the same repository — a
 * monorepo sub-project with its own header, a second checkout — would otherwise read zero while
 * its sibling carried the whole count.
 */
export interface ProjectActivity {
  /** Counts keyed by repository identity, or by `projectActivityKey` where a project has none. */
  readonly countsByRepo: ReadonlyMap<string, ProjectActivityCounts>;
  /** Each project's key into `countsByRepo`, keyed by `projectActivityKey`. */
  readonly repoKeyByProject: ReadonlyMap<string, string>;
}

/** The map's key, one per physical project: the same shape the sidebar keys everything by. */
const projectActivityKey = (environmentId: string, projectId: string): string =>
  `${environmentId}:${projectId}`;

/** Counts saturate here; past it the label reads "99+", which is all a badge that size can say. */
export const PROJECT_ACTIVITY_COUNT_CAP = 99;

const EMPTY_ACTIVITY: ProjectActivity = { countsByRepo: new Map(), repoKeyByProject: new Map() };

/**
 * The feeds' own first-page inputs, field for field: the listing atoms are keyed by their input,
 * so matching the pages exactly is what makes the sidebar's read the same cached answer rather
 * than a second host request.
 */
const PULL_REQUEST_FEED_INPUT: PullRequestListInput = {
  state: "open",
  involvement: "all",
  limit: PULL_REQUEST_LIST_PAGE_SIZE,
};
const LEAD_FEED_INPUT: IssueListInput = {
  state: "open",
  filters: buildLeadListFilters(parseLeadQuery("")),
  limit: LEAD_LIST_PAGE_SIZE,
};

/**
 * The feed pages' own environment split, reproduced so the sidebar asks each server the exact
 * question the page would: same repository assignment, same "list everything you hold" shortcut,
 * and — while the workspace has not said what it holds — the same plain per-server read.
 */
export function buildActivityTargets<
  Input extends {
    readonly state: string;
    readonly projectIds?: ReadonlyArray<ProjectId> | undefined;
  },
>(
  environmentIds: ReadonlyArray<EnvironmentId>,
  projects: ReadonlyArray<AssignableProject>,
  projectsKnown: boolean,
  input: Input,
): ReadonlyArray<EnvironmentQueryTarget<Input>> {
  if (environmentIds.length === 0) return [];
  if (!projectsKnown) return environmentIds.map((environmentId) => ({ environmentId, input }));
  const scoped = projects.filter((project) => environmentIds.includes(project.environmentId));
  return assignEnvironmentProjectQueries(scoped, environmentIds).map(
    ({ environmentId, projectIds }) =>
      projectIds === undefined
        ? { environmentId, input }
        : { environmentId, input: { ...input, projectIds } },
  );
}

/** The identity two projects share when they are copies of one repository; folded like the
 * assignment folds it, so a row lands under the same key whichever copy listed it. */
const projectRepoKey = (project: AssignableProject): string =>
  project.repositoryIdentity?.canonicalKey?.toLowerCase() ??
  projectActivityKey(project.environmentId, project.id);

/**
 * The merged feeds counted per repository. A row from a truncated environment is a floor rather
 * than a total — for every repository that environment listed. Pull-request cursors do name the
 * repository they continue, but a repository the host would not search is read by a fallback
 * whose page cannot be continued, so a missing cursor does not prove a repository was listed
 * whole; nothing in the answer can, so the whole environment floors.
 */
export function deriveProjectActivity(
  projects: ReadonlyArray<AssignableProject>,
  pullRequests: MergedPullRequestList | null,
  leads: MergedIssueList | null,
): ProjectActivity {
  const repoKeyByProject = new Map<string, string>();
  for (const project of projects) {
    repoKeyByProject.set(
      projectActivityKey(project.environmentId, project.id),
      projectRepoKey(project),
    );
  }
  const countsByRepo = new Map<
    string,
    { pullRequests: number; pullRequestsAtLeast: boolean; leads: number; leadsAtLeast: boolean }
  >();
  const bump = (
    entry: { environmentId: string; projectId: string },
    field: "pullRequests" | "leads",
    atLeast: boolean,
  ) => {
    const projectKey = projectActivityKey(entry.environmentId, entry.projectId);
    const repoKey = repoKeyByProject.get(projectKey) ?? projectKey;
    const held = countsByRepo.get(repoKey) ?? {
      pullRequests: 0,
      pullRequestsAtLeast: false,
      leads: 0,
      leadsAtLeast: false,
    };
    held[field] = Math.min(held[field] + 1, PROJECT_ACTIVITY_COUNT_CAP);
    if (atLeast) held[`${field}AtLeast`] = true;
    countsByRepo.set(repoKey, held);
  };

  const pullRequestTruncated = new Set(pullRequests?.truncatedEnvironments ?? []);
  for (const entry of pullRequests?.entries ?? []) {
    bump(entry, "pullRequests", pullRequestTruncated.has(entry.environmentId));
  }
  const leadTruncated = new Set(leads?.truncatedEnvironments ?? []);
  for (const entry of leads?.entries ?? []) {
    bump(entry, "leads", leadTruncated.has(entry.environmentId));
  }
  return { countsByRepo, repoKeyByProject };
}

/** What one sidebar header shows: its member projects' repositories, each counted once. */
export function sumProjectActivity(
  memberProjectRefs: ReadonlyArray<{ environmentId: string; projectId: string }>,
  activity: ProjectActivity,
): ProjectActivityCounts {
  const seen = new Set<string>();
  let pullRequests = 0;
  let leads = 0;
  let pullRequestsAtLeast = false;
  let leadsAtLeast = false;
  for (const ref of memberProjectRefs) {
    const projectKey = projectActivityKey(ref.environmentId, ref.projectId);
    const repoKey = activity.repoKeyByProject.get(projectKey) ?? projectKey;
    if (seen.has(repoKey)) continue;
    seen.add(repoKey);
    const counts = activity.countsByRepo.get(repoKey);
    if (counts === undefined) continue;
    pullRequests = Math.min(pullRequests + counts.pullRequests, PROJECT_ACTIVITY_COUNT_CAP);
    leads = Math.min(leads + counts.leads, PROJECT_ACTIVITY_COUNT_CAP);
    pullRequestsAtLeast ||= counts.pullRequestsAtLeast;
    leadsAtLeast ||= counts.leadsAtLeast;
  }
  return { pullRequests, pullRequestsAtLeast, leads, leadsAtLeast };
}

/**
 * Open pull requests and open leads per repository, for the sidebar's project headers.
 *
 * The sidebar is always on screen, so this deliberately costs what the Pull Requests and Leads
 * pages already cost and nothing more: it sends each capable server the pages' own first-page
 * input — same fields, same page size, same project assignment — so the listing atoms and the
 * server's cache answer both surfaces with one read. Refresh rides the idle-aware live cadence,
 * and nothing is read at all while `enabled` is false. Nothing here may ever turn into a request
 * per project.
 */
export function useProjectActivity(enabled: boolean): ProjectActivity {
  const { environments } = useEnvironments();
  const allProjects = useProjects();
  const projectsKnown = useAllEnvironmentShellsBootstrapped();

  // Sorted exactly as the pages sort their capable environments, so the assignment's preferred
  // server — and with it every target's input — comes out identical.
  const capableIds = useMemo(() => {
    const prs: EnvironmentId[] = [];
    const leads: EnvironmentId[] = [];
    for (const environment of environments) {
      const capabilities = environment.serverConfig?.environment.capabilities;
      if (capabilities?.pullRequests === true) prs.push(environment.environmentId);
      if (capabilities?.issues === true) leads.push(environment.environmentId);
    }
    const order = (left: EnvironmentId, right: EnvironmentId) => left.localeCompare(right);
    return { prs: prs.toSorted(order), leads: leads.toSorted(order) };
  }, [environments]);

  const pullRequestTargets = useMemo(
    () =>
      enabled
        ? buildActivityTargets(capableIds.prs, allProjects, projectsKnown, PULL_REQUEST_FEED_INPUT)
        : [],
    [allProjects, capableIds.prs, enabled, projectsKnown],
  );
  const leadTargets = useMemo(
    () =>
      enabled
        ? buildActivityTargets(capableIds.leads, allProjects, projectsKnown, LEAD_FEED_INPUT)
        : [],
    [allProjects, capableIds.leads, enabled, projectsKnown],
  );

  const pullRequestQuery = usePullRequestList(pullRequestTargets);
  const leadQuery = useIssueList(leadTargets);

  // A feed page on screen runs its own live refresh over these same atoms; ticking here too
  // would phase-shift two five-minute loops into reads twice as often. The open feed owns its
  // refresh, and the router is read inside the tick so nothing re-renders on navigation.
  const router = useRouter();
  useLiveRefresh(
    () => {
      const pathname = router.state.location.pathname;
      if (!pathname.startsWith("/pull-requests")) pullRequestQuery.refresh();
      if (!pathname.startsWith("/leads")) leadQuery.refresh();
    },
    {
      enabled: enabled && (pullRequestTargets.length > 0 || leadTargets.length > 0),
      key: "sidebar-project-activity",
    },
  );

  return useMemo(() => {
    if (!enabled) return EMPTY_ACTIVITY;
    return deriveProjectActivity(allProjects, pullRequestQuery.data, leadQuery.data);
  }, [allProjects, enabled, leadQuery.data, pullRequestQuery.data]);
}
