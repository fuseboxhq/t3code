import { GitPullRequestIcon, TargetIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  PROJECT_ACTIVITY_COUNT_CAP,
  sumProjectActivity,
  type ProjectActivity,
} from "../../state/projectActivityCounts";

/** A floor gets the "+", and so does the cap: past either, the exact number is not known. */
const countLabel = (count: number, atLeast: boolean): string =>
  atLeast || count >= PROJECT_ACTIVITY_COUNT_CAP ? `${count}+` : String(count);

const ariaLabel = (count: number, atLeast: boolean, noun: string): string =>
  `${atLeast || count >= PROJECT_ACTIVITY_COUNT_CAP ? "at least " : ""}${count} open ${noun}${
    count === 1 ? "" : "s"
  }`;

/**
 * The second line of a sidebar project header: how many open pull requests and open leads the
 * project's repositories carry. Nothing renders until a count is known and non-zero, so a quiet
 * project keeps its one-line header and the sidebar its rhythm.
 */
export const ProjectActivityBadges = memo(function ProjectActivityBadges({
  memberProjectRefs,
  activity,
}: {
  memberProjectRefs: ReadonlyArray<{ environmentId: string; projectId: string }>;
  activity: ProjectActivity;
}) {
  const { pullRequests, pullRequestsAtLeast, leads, leadsAtLeast } = useMemo(
    () => sumProjectActivity(memberProjectRefs, activity),
    [activity, memberProjectRefs],
  );

  if (pullRequests === 0 && leads === 0) return null;
  return (
    <span
      aria-label={[
        pullRequests > 0 ? ariaLabel(pullRequests, pullRequestsAtLeast, "pull request") : null,
        leads > 0 ? ariaLabel(leads, leadsAtLeast, "lead") : null,
      ]
        .filter(Boolean)
        .join(", ")}
      className="mt-px flex items-center gap-2.5 text-[11px] leading-4 text-sidebar-muted-foreground/70"
    >
      {pullRequests > 0 ? (
        <span className="flex items-center gap-1">
          <GitPullRequestIcon aria-hidden className="size-3 shrink-0" />
          <span className="tabular-nums">{countLabel(pullRequests, pullRequestsAtLeast)}</span>
        </span>
      ) : null}
      {leads > 0 ? (
        <span className="flex items-center gap-1">
          <TargetIcon aria-hidden className="size-3 shrink-0" />
          <span className="tabular-nums">{countLabel(leads, leadsAtLeast)}</span>
        </span>
      ) : null}
    </span>
  );
});
