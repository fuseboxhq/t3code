import type { ContextMenuItem } from "@t3tools/contracts";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";

import { toastManager } from "../ui/toast";

export type PullRequestRowContextMenuAction =
  | "work-worktree"
  | "work-local"
  | "copy-link"
  | "open-external";

/**
 * Work first, worktree first: the right-click on a row is the shortcut to a thread, and the
 * worktree is the hand-off that leaves whatever is open alone. Checking out in the repository
 * itself moves the branch under everything else open there, so it is the explicit second choice.
 */
export function pullRequestRowContextMenuItems(
  openLabel: string,
): readonly ContextMenuItem<PullRequestRowContextMenuAction>[] {
  return [
    { id: "work-worktree", label: "Work on this in a new worktree", icon: "git-branch" },
    { id: "work-local", label: "Work on this in the current checkout" },
    { id: "copy-link", label: "Copy link", icon: "copy" },
    { id: "open-external", label: openLabel },
  ];
}

/**
 * The right-click on a pull request row: the two ways to hand the pull request to a thread,
 * plus the link actions the number already offers. The work actions come back to the caller,
 * which owns the checkout machinery; the link actions are settled here.
 */
export async function showPullRequestRowContextMenu({
  url,
  openLabel,
  position,
  onWork,
}: {
  readonly url: string;
  readonly openLabel: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly onWork: (mode: "worktree" | "local") => void;
}): Promise<void> {
  const api = readLocalApi();
  if (!api) return;
  let action: PullRequestRowContextMenuAction | null = null;
  try {
    action = await api.contextMenu.show(pullRequestRowContextMenuItems(openLabel), position);
  } catch {
    return;
  }
  if (action === "work-worktree") return onWork("worktree");
  if (action === "work-local") return onWork("local");
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
