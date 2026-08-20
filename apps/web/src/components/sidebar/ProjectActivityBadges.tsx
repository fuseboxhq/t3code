import { GitPullRequestIcon, TargetIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  PROJECT_ACTIVITY_COUNT_CAP,
  projectActivityKey,
  type ProjectActivityCounts,
} from "../../state/projectActivityCounts";

const countLabel = (count: number): string =>
  count >= PROJECT_ACTIVITY_COUNT_CAP ? `${PROJECT_ACTIVITY_COUNT_CAP}+` : String(count);

/**
 * The second line of a sidebar project header: how many open pull requests and open leads the
 * project's repository carries. Nothing renders until a count is known and non-zero, so a quiet
 * project keeps its one-line header and the sidebar its rhythm.
 */
export const ProjectActivityBadges = memo(function ProjectActivityBadges({
  memberProjectRefs,
  countsByKey,
}: {
  memberProjectRefs: ReadonlyArray<{ environmentId: string; projectId: string }>;
  countsByKey: ReadonlyMap<string, ProjectActivityCounts>;
}) {
  const { pullRequests, leads } = useMemo(() => {
    let pullRequestsTotal = 0;
    let leadsTotal = 0;
    for (const ref of memberProjectRefs) {
      const counts = countsByKey.get(projectActivityKey(ref.environmentId, ref.projectId));
      if (counts === undefined) continue;
      pullRequestsTotal = Math.min(
        pullRequestsTotal + counts.pullRequests,
        PROJECT_ACTIVITY_COUNT_CAP,
      );
      leadsTotal = Math.min(leadsTotal + counts.leads, PROJECT_ACTIVITY_COUNT_CAP);
    }
    return { pullRequests: pullRequestsTotal, leads: leadsTotal };
  }, [countsByKey, memberProjectRefs]);

  if (pullRequests === 0 && leads === 0) return null;
  return (
    <span
      aria-label={[
        pullRequests > 0
          ? `${countLabel(pullRequests)} open pull request${pullRequests === 1 ? "" : "s"}`
          : null,
        leads > 0 ? `${countLabel(leads)} open lead${leads === 1 ? "" : "s"}` : null,
      ]
        .filter(Boolean)
        .join(", ")}
      className="mt-px flex items-center gap-2.5 text-[11px] leading-4 text-sidebar-muted-foreground/70"
    >
      {pullRequests > 0 ? (
        <span className="flex items-center gap-1">
          <GitPullRequestIcon aria-hidden className="size-3 shrink-0" />
          <span className="tabular-nums">{countLabel(pullRequests)}</span>
        </span>
      ) : null}
      {leads > 0 ? (
        <span className="flex items-center gap-1">
          <TargetIcon aria-hidden className="size-3 shrink-0" />
          <span className="tabular-nums">{countLabel(leads)}</span>
        </span>
      ) : null}
    </span>
  );
});
