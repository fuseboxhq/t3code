import type { EnvironmentId, IssueListInput, PullRequestListInput } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { LEAD_LABEL } from "../components/leads/leadsList.logic";
import { assignProjectsToEnvironments } from "../components/pullRequest/pullRequestProjectAssignment.logic";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { useProjects } from "./entities";
import { useEnvironments } from "./environments";
import { useIssueList } from "./issues";
import { usePullRequestList, type EnvironmentQueryTarget } from "./pullRequests";

export interface ProjectActivityCounts {
  readonly pullRequests: number;
  readonly leads: number;
}

/** The map's key, one per physical project: the same shape the sidebar keys everything by. */
export const projectActivityKey = (environmentId: string, projectId: string): string =>
  `${environmentId}:${projectId}`;

const EMPTY_TARGETS: ReadonlyArray<EnvironmentQueryTarget<never>> = [];
/** Counts saturate at the feeds' own page size; past it the label reads "99+"-style anyway. */
export const PROJECT_ACTIVITY_COUNT_CAP = 99;

/**
 * Open pull requests and open leads per project, for the sidebar's project headers.
 *
 * The sidebar is always on screen, so this deliberately costs what the Pull Requests and Leads
 * pages already cost and nothing more: one listing per capable server per feed — shared with
 * those pages through the same atoms and the server's own cache — counted client-side, refreshed
 * on the idle-aware live cadence, and not read at all while `enabled` is false. Nothing here may
 * ever turn into a request per project.
 *
 * Counts cap at one listing page per repository; a project past the cap reads as "99+", which
 * is the only honest thing a badge that size can say.
 */
export function useProjectActivityCounts(
  enabled: boolean,
): ReadonlyMap<string, ProjectActivityCounts> {
  const { environments } = useEnvironments();
  const allProjects = useProjects();

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

  // Each repository is listed by one server, the way the pages themselves split the work, so a
  // repository two servers hold is counted once rather than twice.
  const targetsFor = useCallback(
    <Input>(
      environmentIds: ReadonlyArray<EnvironmentId>,
      input: Input,
    ): ReadonlyArray<EnvironmentQueryTarget<Input>> => {
      if (!enabled || environmentIds.length === 0) return [];
      const projects = allProjects.filter((project) =>
        environmentIds.includes(project.environmentId),
      );
      const assignment = assignProjectsToEnvironments(projects, environmentIds, environmentIds[0]);
      const totals = new Map<string, number>();
      for (const project of projects) {
        totals.set(project.environmentId, (totals.get(project.environmentId) ?? 0) + 1);
      }
      return environmentIds.flatMap((environmentId) => {
        const projectIds = assignment.get(environmentId);
        if (projectIds === undefined) return [];
        if (projectIds.length === (totals.get(environmentId) ?? 0)) {
          return [{ environmentId, input }];
        }
        return [{ environmentId, input: { ...input, projectIds } }];
      });
    },
    [allProjects, enabled],
  );

  const pullRequestTargets = useMemo(
    () =>
      targetsFor(capableIds.prs, {
        state: "open",
        involvement: "all",
      } satisfies PullRequestListInput),
    [capableIds.prs, targetsFor],
  );
  const leadTargets = useMemo(
    () =>
      targetsFor(capableIds.leads, {
        state: "open",
        filters: { labels: [[LEAD_LABEL]] },
      } satisfies IssueListInput),
    [capableIds.leads, targetsFor],
  );

  const pullRequestQuery = usePullRequestList(
    pullRequestTargets.length === 0
      ? (EMPTY_TARGETS as ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>)
      : pullRequestTargets,
  );
  const leadQuery = useIssueList(
    leadTargets.length === 0
      ? (EMPTY_TARGETS as ReadonlyArray<EnvironmentQueryTarget<IssueListInput>>)
      : leadTargets,
  );

  useLiveRefresh(
    () => {
      pullRequestQuery.refresh();
      leadQuery.refresh();
    },
    {
      enabled: enabled && (pullRequestTargets.length > 0 || leadTargets.length > 0),
      key: "sidebar-project-activity",
    },
  );

  return useMemo(() => {
    const counts = new Map<string, { pullRequests: number; leads: number }>();
    const bump = (environmentId: string, projectId: string, field: "pullRequests" | "leads") => {
      const key = projectActivityKey(environmentId, projectId);
      const held = counts.get(key) ?? { pullRequests: 0, leads: 0 };
      held[field] = Math.min(held[field] + 1, PROJECT_ACTIVITY_COUNT_CAP);
      counts.set(key, held);
    };
    for (const entry of pullRequestQuery.data?.entries ?? []) {
      bump(entry.environmentId, entry.projectId, "pullRequests");
    }
    for (const entry of leadQuery.data?.entries ?? []) {
      bump(entry.environmentId, entry.projectId, "leads");
    }
    return counts;
  }, [leadQuery.data?.entries, pullRequestQuery.data?.entries]);
}
