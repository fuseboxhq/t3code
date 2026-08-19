import { CheckCircle2Icon, CircleDotIcon, MessageSquareIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { PullRequestActorLabel, PullRequestMetaLine } from "../pullRequest/pullRequestPresentation";
import { LEAD_LABEL, type EnvironmentIssueEntry } from "./leadsList.logic";

/** GitHub's own issue-state glyphs: an open green dot, a closed purple check. */
function LeadStateGlyph({ state }: { state: EnvironmentIssueEntry["state"] }) {
  const Icon = state === "open" ? CircleDotIcon : CheckCircle2Icon;
  return (
    <Icon
      aria-label={state === "open" ? "Open" : "Closed"}
      className={cn(
        "size-4 shrink-0",
        state === "open"
          ? "text-emerald-600 dark:text-emerald-300/90"
          : "text-violet-600 dark:text-violet-300/90",
      )}
    />
  );
}

function LeadRowImpl({
  entry,
  selected,
  environmentLabel,
  onSelect,
}: {
  entry: EnvironmentIssueEntry;
  selected: boolean;
  /** Names the server this row was read from, where the list spans more than one. */
  environmentLabel?: string;
  onSelect: (entry: EnvironmentIssueEntry) => void;
}) {
  // The pinned label is what every row here wears; repeating it per row would say nothing.
  const labels = entry.labels.filter((label) => label.name.toLowerCase() !== LEAD_LABEL);
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(entry)}
      className={cn(
        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "[contain-intrinsic-block-size:54px] [content-visibility:auto]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <LeadStateGlyph state={entry.state} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{entry.title}</span>
        <PullRequestMetaLine className="mt-0.5 text-xs text-muted-foreground/70">
          <span className="shrink-0">#{entry.number}</span>
          <PullRequestActorLabel actor={entry.author} className="max-w-40 shrink-0" />
          {labels.slice(0, 3).map((label) => (
            <span
              key={label.name}
              className="max-w-28 shrink-0 truncate rounded-full border border-border px-1.5 py-px text-[0.7rem]"
            >
              {label.name}
            </span>
          ))}
          {environmentLabel ? (
            <span className="max-w-32 shrink-0 truncate">{environmentLabel}</span>
          ) : null}
        </PullRequestMetaLine>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground/70">
        {entry.commentCount !== undefined && entry.commentCount > 0 ? (
          <span className="flex items-center gap-1">
            <MessageSquareIcon aria-hidden className="size-3" />
            {entry.commentCount}
          </span>
        ) : null}
        <span className="shrink-0">{formatRelativeTimeLabel(entry.updatedAt)}</span>
      </span>
    </button>
  );
}

export const LeadRow = memo(LeadRowImpl);
