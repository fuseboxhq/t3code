import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback, useRef } from "react";

import { useComposerHandoff, type ComposerHandoffTask } from "~/hooks/useComposerHandoff";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { gitEnvironment } from "~/state/git";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../ui/toast";
import { readableFailure } from "./pullRequestDetail.logic";

/**
 * Checks a pull request out and opens a thread on the checkout, optionally leaving a task in
 * its composer. One flow for the detail panel's hand-offs and the list row's context menu, so
 * "work on this pull request" means the same thing wherever it is asked from.
 *
 * The thread is opened before the checkout because the project's setup script only runs for a
 * checkout that knows which thread it is for; the same thread is then re-pointed at the
 * prepared branch. A worktree leaves whatever is open alone, which is why callers default to
 * it; "local" moves the repository's own working tree onto the branch.
 */
export function usePullRequestThreadCheckout() {
  const newThread = useNewThreadHandler();
  const { openThreadWithTask } = useComposerHandoff();
  const prepare = useAtomCommand(gitEnvironment.preparePullRequestThread, {
    reportFailure: false,
  });
  // One checkout at a time, guarded here rather than at each call site: the menu closes on the
  // press and nothing else says "already running", so two concurrent flows would race the same
  // working tree, and the second would open a thread it then abandons.
  const inFlight = useRef(false);

  return useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      /** The checkout the preparation runs in: the acting project's workspace root. */
      readonly cwd: string;
      /** The pull request's own URL, which is how the server resolves it. */
      readonly reference: string;
      readonly mode: "worktree" | "local";
      readonly task: ComposerHandoffTask | null;
    }): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      try {
        // The menu closes on the press, so this toast is the only thing answering for the
        // checkout. It carries no timeout: a loading toast never expires, and an explicit one
        // would survive the update and pin the result on screen.
        const toastId = toastManager.add({
          type: "loading",
          title: "Preparing the pull request checkout...",
        });
        const projectRef = scopeProjectRef(input.environmentId, input.projectId);
        const opened = await newThread(projectRef).then(
          (session) => session,
          () => null,
        );
        if (opened === null) {
          // Without a thread there is nowhere for the checkout to belong: its setup script would
          // not run and its task would have no composer to land in. Better to stop before
          // touching the working tree than to prepare a worktree nobody asked for.
          toastManager.update(toastId, {
            type: "error",
            title: "Could not open a thread for the checkout",
            description: "Try again from the project, or open a thread first.",
          });
          return false;
        }
        const prepared = await prepare({
          environmentId: input.environmentId,
          input: {
            cwd: input.cwd,
            reference: input.reference,
            mode: input.mode,
            threadId: opened.threadId,
          },
        });
        if (prepared._tag === "Failure") {
          // The server says what to do about it — that the branch is already checked out in the
          // main repository, say — and that sentence is the only way out of the failure.
          toastManager.update(toastId, {
            type: "error",
            title: "Could not prepare the pull request checkout",
            description: readableFailure(
              squashAtomCommandFailure(prepared),
              "The checkout could not be prepared.",
            ),
          });
          return false;
        }
        // The same thread again, now that there is somewhere to point it at. A local checkout has
        // no worktree of its own, so the thread runs where the repository already is.
        const pointed = await newThread(projectRef, {
          branch: prepared.value.branch,
          worktreePath: prepared.value.worktreePath,
          envMode: prepared.value.worktreePath === null ? "local" : "worktree",
        }).then(
          (session) => session !== null,
          () => false,
        );
        if (!pointed) {
          // The checkout is on disk; only the thread failed to move onto it. Writing the task now
          // would send the agent at whatever the thread was already open on — which is the one
          // outcome worth stopping for, since it reads as success and is not.
          toastManager.update(toastId, {
            type: "error",
            title: "Checked out, but the thread stayed where it was",
            description: `The checkout is ready on \`${prepared.value.branch}\`. Point a thread at it from the branch picker, then ask again.`,
          });
          return false;
        }
        // A worktree that was already there and had been worked in keeps whatever it holds, so
        // the thread opens on older code than the pull request carries. Said once, in place of
        // the success, because everything else about the handoff did happen.
        const staleCheckoutToast = {
          type: "warning",
          title: "Checked out, but not on the latest commits",
          description:
            "The checkout could not be moved onto the pull request's latest commits, so the code there is older than the pull request. Uncommitted work or local commits keep it where it is.",
        } as const;
        if (input.task === null) {
          toastManager.update(
            toastId,
            prepared.value.isOnPullRequestHead
              ? {
                  type: "success",
                  title: input.mode === "local" ? "Checked out here" : "Checked out",
                  description:
                    input.mode === "local"
                      ? "This repository is on the pull request's branch, with a thread open on it."
                      : "The pull request is in its own worktree, with a thread open on it.",
                }
              : staleCheckoutToast,
          );
          return true;
        }
        await openThreadWithTask(projectRef, input.task, { opened });
        toastManager.update(
          toastId,
          prepared.value.isOnPullRequestHead
            ? {
                type: "success",
                title: "Checkout ready",
                description: "The task is in the composer — read it over, then send.",
              }
            : staleCheckoutToast,
        );
        return true;
      } finally {
        inFlight.current = false;
      }
    },
    [newThread, openThreadWithTask, prepare],
  );
}
