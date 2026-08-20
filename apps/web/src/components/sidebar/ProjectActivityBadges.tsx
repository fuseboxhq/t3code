import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
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
  `Open ${noun}s: ${atLeast || count >= PROJECT_ACTIVITY_COUNT_CAP ? "at least " : ""}${count} — open the ${noun} list for this project`;

const badgeClassName =
  "flex cursor-pointer items-center gap-1 rounded-sm outline-none hover:text-sidebar-foreground focus-visible:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The second line of a sidebar project header: how many open pull requests and open leads the
 * project's repositories carry, each a link to its feed page scoped to this project. Nothing
 * renders until a count is known and non-zero, so a quiet project keeps its one-line header and
 * the sidebar its rhythm. Rendered beside the header button rather than inside it — a link nested
 * in a button is reachable by neither keyboard nor screen reader.
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

  // The group's own project fronts its members, and the feed pages resolve the id across
  // servers — an ambiguous one still narrows to only the servers that hold it.
  const front = memberProjectRefs[0];
  if ((pullRequests === 0 && leads === 0) || front === undefined) return null;
  const projectId = front.projectId as ProjectId;
  const environmentId = front.environmentId as EnvironmentId;
  return (
    <span className="mt-px flex items-center gap-2.5 pb-1 pl-14 text-[11px] leading-4 text-sidebar-muted-foreground/70">
      {/* The pull-request slot holds its width even when empty, so the lead counts line up in
          one column down the sidebar rather than sliding left on a project with no open PRs. */}
      <span className="min-w-9">
        {pullRequests > 0 ? (
          <Link
            to="/pull-requests"
            search={{ involvement: "all", state: "open", projectId, environmentId }}
            aria-label={ariaLabel(pullRequests, pullRequestsAtLeast, "pull request")}
            className={badgeClassName}
          >
            <GitPullRequestIcon aria-hidden className="size-3 shrink-0" />
            <span className="tabular-nums">{countLabel(pullRequests, pullRequestsAtLeast)}</span>
          </Link>
        ) : null}
      </span>
      {leads > 0 ? (
        <Link
          to="/leads"
          search={{ state: "open", projectId }}
          aria-label={ariaLabel(leads, leadsAtLeast, "lead")}
          className={badgeClassName}
        >
          <TargetIcon aria-hidden className="size-3 shrink-0" />
          <span className="tabular-nums">{countLabel(leads, leadsAtLeast)}</span>
        </Link>
      ) : null}
    </span>
  );
});
