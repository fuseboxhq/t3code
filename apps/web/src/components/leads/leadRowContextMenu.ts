import type { ContextMenuItem } from "@t3tools/contracts";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";

import { toastManager } from "../ui/toast";

export type LeadRowContextMenuAction =
  | "start-worktree"
  | "start-local"
  | "copy-link"
  | "open-external";

/**
 * Work first, worktree first, for the reason the pull-request row gives: a worktree leaves the
 * current checkout — and whatever threads are running on it — alone. A lead's "current
 * checkout" moves no branch, but it does put the agent to work on top of whatever state is
 * sitting there.
 */
export function leadRowContextMenuItems(): readonly ContextMenuItem<LeadRowContextMenuAction>[] {
  return [
    { id: "start-worktree", label: "Start working in a new worktree", icon: "git-branch" },
    { id: "start-local", label: "Start working in the current checkout" },
    { id: "copy-link", label: "Copy link", icon: "copy" },
    { id: "open-external", label: "Open on GitHub" },
  ];
}

/**
 * The right-click on a lead row: the two ways to hand the lead to a thread, plus the link
 * actions. The start actions come back to the caller, which owns the hand-off; the link
 * actions are settled here.
 */
export async function showLeadRowContextMenu({
  url,
  position,
  onStart,
}: {
  readonly url: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly onStart: (mode: "worktree" | "local") => void;
}): Promise<void> {
  const api = readLocalApi();
  if (!api) return;
  let action: LeadRowContextMenuAction | null = null;
  try {
    action = await api.contextMenu.show(leadRowContextMenuItems(), position);
  } catch {
    return;
  }
  if (action === "start-worktree") return onStart("worktree");
  if (action === "start-local") return onStart("local");
  try {
    if (action === "copy-link") await writeTextToClipboard(url, "link");
    else if (action === "open-external") await api.shell.openExternal(url);
  } catch {
    toastManager.add({
      type: "error",
      title: action === "copy-link" ? "Could not copy the link" : "Could not open the link",
    });
  }
}
