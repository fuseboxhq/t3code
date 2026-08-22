import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, SummaryGeneration, ThreadSummary } from "@t3tools/contracts";
import { ScrollTextIcon } from "lucide-react";
import { memo, useCallback, useEffect } from "react";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadSummaryUiStore } from "../../threadSummaryUiStore";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Shared popover body for thread and project summaries. */
export function SummaryPopoverBody(props: {
  readonly title: string;
  readonly text: string | null;
  readonly generatedAt: string | null;
  readonly pending: boolean;
  readonly onRegenerate: () => void;
}) {
  return (
    <div className="flex w-[26rem] max-w-[calc(100vw-2rem)] flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{props.title}</span>
        <span className="text-xs text-muted-foreground">
          {props.pending
            ? "Summarising…"
            : props.generatedAt
              ? `Updated ${formatRelativeTimeLabel(props.generatedAt)}`
              : "Not generated yet"}
        </span>
      </div>
      {props.text ? (
        <p className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed">
          {props.text}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {props.pending
            ? "The first summary is on its way."
            : "No summary yet. Generate one to see where this stands."}
        </p>
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="outline" disabled={props.pending} onClick={props.onRegenerate}>
          {props.pending ? <Spinner className="size-3.5" /> : null}
          {props.text ? "Regenerate" : "Generate summary"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Chat-header button that shows the active thread's summary and lets the user
 * refresh it. The sidebar's "Summary" menu item opens this through
 * `useThreadSummaryUiStore` after navigating here.
 */
export const ThreadSummaryControl = memo(function ThreadSummaryControl(props: {
  readonly threadRef: ScopedThreadRef;
  readonly summary: ThreadSummary | null;
  readonly summaryGeneration: SummaryGeneration | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { threadRef, summary, summaryGeneration, open, onOpenChange } = props;
  const threadKey = scopedThreadKey(threadRef);
  const pendingThreadKey = useThreadSummaryUiStore((store) => store.pendingThreadKey);
  const consume = useThreadSummaryUiStore((store) => store.consume);
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });

  useEffect(() => {
    if (pendingThreadKey !== threadKey) return;
    consume(threadKey);
    onOpenChange(true);
  }, [consume, onOpenChange, pendingThreadKey, threadKey]);

  const regenerate = useCallback(() => {
    void updateThreadMetadata({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, regenerateSummary: true },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to regenerate summary",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    });
  }, [threadRef, updateThreadMetadata]);

  const pending = summaryGeneration != null;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<Button size="icon-xs" variant="outline" aria-label="Thread summary" />}
            />
          }
        >
          {pending ? <Spinner className="size-4" /> : <ScrollTextIcon className="size-4" />}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{pending ? "Summarising…" : "Thread summary"}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" side="bottom">
        <SummaryPopoverBody
          title="Thread summary"
          text={summary?.text ?? null}
          generatedAt={summary?.generatedAt ?? null}
          pending={pending}
          onRegenerate={regenerate}
        />
      </PopoverPopup>
    </Popover>
  );
});
