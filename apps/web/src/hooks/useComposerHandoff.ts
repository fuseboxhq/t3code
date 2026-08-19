import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import {
  handoffPrompt,
  handoffReviewComments,
} from "../components/pullRequest/pullRequestDetail.logic";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import type { ReviewCommentContext } from "../reviewCommentContext";
import { useNewThreadHandler } from "./useHandleNewThread";

/** What a hand-off puts in a composer: a prompt, and any review comments riding with it. */
export interface ComposerHandoffTask {
  readonly prompt: string;
  readonly reviewComments?: ReadonlyArray<ReviewCommentContext>;
}

/**
 * What the last hand-off wrote into each draft, kept outside React because the panel that wrote
 * it is closed by the time the next one opens. It is how a prompt the reader has since edited is
 * told apart from the one they were handed: only the sentence still exactly as written may be
 * replaced.
 */
const lastHandoffPromptByDraft = new Map<string, string>();

const composerTargetKey = (target: ScopedThreadRef | DraftId): string =>
  typeof target === "string" ? target : scopedThreadKey(target);

/**
 * Writes a task into a composer draft, replacing only what the last hand-off wrote: the latest
 * press is the ask, and what the reader typed themselves survives. Shared by the pull-request
 * and lead panels, which hand work to threads the same way.
 */
export function writeTaskToComposer(
  target: ScopedThreadRef | DraftId,
  task: ComposerHandoffTask,
): void {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  const key = composerTargetKey(target);
  const prompt = handoffPrompt(
    { prompt: draft?.prompt ?? "", lastHandoffPrompt: lastHandoffPromptByDraft.get(key) },
    task.prompt,
  );
  lastHandoffPromptByDraft.set(key, task.prompt);
  store.setPrompt(target, prompt);
  store.setReviewComments(
    target,
    handoffReviewComments(draft?.reviewComments ?? [], task.reviewComments ?? []),
  );
}

/**
 * Opens a thread on a project and leaves the task in its composer for the reader to send.
 *
 * Nothing is checked out and nothing is sent: asking is not a reason to move somebody's working
 * tree, and the draft stays the reader's to edit or discard. Callers that prepare a checkout
 * first pass the session they already opened, so there is one path from "a task" to "a thread
 * holding it".
 */
export function useComposerHandoff() {
  const newThread = useNewThreadHandler();

  const openThreadWithTask = useCallback(
    async (
      projectRef: ScopedProjectRef,
      task: ComposerHandoffTask | null,
      opened?: { draftId: DraftId; threadId?: ThreadId },
    ): Promise<{ draftId: DraftId } | null> => {
      const session =
        opened ??
        (await newThread(projectRef).then(
          (result) => result,
          () => null,
        ));
      if (session === null) return null;
      if (task === null) return session;
      writeTaskToComposer(session.draftId, task);
      return session;
    },
    [newThread],
  );

  return useMemo(() => ({ openThreadWithTask, writeTaskToComposer }), [openThreadWithTask]);
}
