import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { ScrollTextIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { useProject } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { SummaryPopoverBody } from "./chat/ThreadSummaryControl";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Regenerate a project's summary, toasting on failure. Shared by the hover
 * button and the project context menu.
 */
export function useRegenerateProjectSummary() {
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  return useCallback(
    (projectRef: ScopedProjectRef) => {
      void updateProject({
        environmentId: projectRef.environmentId,
        input: { projectId: projectRef.projectId, regenerateSummary: true },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Failed to regenerate project summary",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
      });
    },
    [updateProject],
  );
}

/**
 * Sidebar project-row button (hover-revealed) showing the project's rolled-up
 * summary. Controlled so the project context menu can open it too.
 */
export const ProjectSummaryControl = memo(function ProjectSummaryControl(props: {
  readonly projectRef: ScopedProjectRef;
  readonly displayName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly className?: string;
}) {
  const { projectRef, displayName, open, onOpenChange, className } = props;
  const project = useProject(projectRef);
  const regenerate = useRegenerateProjectSummary();
  const pending = project?.summaryGeneration != null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={`Summary of ${displayName}`}
                  className={className}
                />
              }
            />
          }
        >
          {pending ? <Spinner className="size-3.5" /> : <ScrollTextIcon className="size-3.5" />}
        </TooltipTrigger>
        <TooltipPopup side="top">{pending ? "Summarising…" : "Project summary"}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" side="right">
        <SummaryPopoverBody
          title={displayName}
          text={project?.summary?.text ?? null}
          generatedAt={project?.summary?.generatedAt ?? null}
          pending={pending}
          onRegenerate={() => regenerate(projectRef)}
        />
      </PopoverPopup>
    </Popover>
  );
});
