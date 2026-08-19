import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueRef, ProjectId } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDotIcon,
  HammerIcon,
  LoaderIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useComposerHandoff } from "~/hooks/useComposerHandoff";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestActorLabel } from "../pullRequest/pullRequestPresentation";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { IssueMarkdown } from "./IssueMarkdown";
import { buildLeadHandoffPrompt } from "./leadsList.logic";

/**
 * One page of the conversation, and behind it the next. Recursion is the pagination: each page
 * renders its own comments and, once the reader asks, mounts the page its cursor names — so an
 * arbitrarily long conversation loads a bounded page at a time and nothing is re-fetched.
 */
function LeadActivityPages({
  environmentId,
  reference,
  cursor,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  cursor?: string;
}) {
  const query = useEnvironmentQuery(
    issueEnvironment.activity({
      environmentId,
      input: { ...reference, ...(cursor === undefined ? {} : { cursor }) },
    }),
  );
  const [expanded, setExpanded] = useState(false);
  const page = query.data;
  if (page === null) {
    return query.error === null ? (
      <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
        <LoaderIcon aria-hidden className="size-3 animate-spin" />
        Loading comments
      </div>
    ) : (
      <div className="flex items-center justify-between gap-2 px-1 py-2 text-xs text-muted-foreground">
        <span>The comments could not be loaded.</span>
        <Button size="xs" variant="outline" onClick={query.refresh}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <>
      {page.comments.map((comment) => (
        <div key={comment.id} className="rounded-lg border border-border/60 bg-card/40 p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <PullRequestActorLabel actor={comment.author} className="max-w-48" />
            <span>{formatRelativeTimeLabel(comment.createdAt)}</span>
          </div>
          <IssueMarkdown className="mt-2" text={comment.body} />
        </div>
      ))}
      {page.nextCursor !== null ? (
        expanded ? (
          <LeadActivityPages
            environmentId={environmentId}
            reference={reference}
            cursor={page.nextCursor}
          />
        ) : (
          <Button
            className="self-start"
            size="xs"
            variant="outline"
            onClick={() => setExpanded(true)}
          >
            <ChevronDownIcon aria-hidden className="size-3.5" />
            {page.commentCount > page.comments.length
              ? `Load more (${page.commentCount} total)`
              : "Load more"}
          </Button>
        )
      ) : null}
    </>
  );
}

export function LeadDetailPanel({
  environmentId,
  reference,
  refreshToken: forcedRefreshToken = 0,
  onActed,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /** Bumped by the page's own refresh, so the panel re-reads with the list. */
  refreshToken?: number;
  /** Closing or reopening changes the row this panel was opened from. */
  onActed?: () => void;
}) {
  const detailQuery = useEnvironmentQuery(
    issueEnvironment.detail({ environmentId, input: reference }),
  );
  const detail = detailQuery.data;
  const { environments } = useEnvironments();
  const projects = useProjects();
  const { openThreadWithTask } = useComposerHandoff();

  // The comment pages live under a key so a mutation can start the conversation over from the
  // first page: the recursion above caches per cursor, and yesterday's cursors name yesterday's
  // pages.
  const [activityEpoch, setActivityEpoch] = useState(0);
  const refreshDetail = useCallback(() => {
    detailQuery.refresh();
    setActivityEpoch((epoch) => epoch + 1);
  }, [detailQuery.refresh]);

  const invalidate = useAtomCommand(issueEnvironment.invalidate, { reportFailure: false });
  const refreshFromHost = useCallback(async () => {
    // The invalidation goes first so the re-reads miss the server's cache; if it fails, the
    // reads still run and at worst answer from it.
    await invalidate({ environmentId, input: { reference } });
    refreshDetail();
  }, [environmentId, invalidate, reference, refreshDetail]);
  const appliedForcedToken = useRef(forcedRefreshToken);
  useEffect(() => {
    if (appliedForcedToken.current === forcedRefreshToken) return;
    appliedForcedToken.current = forcedRefreshToken;
    void refreshFromHost();
  }, [forcedRefreshToken, refreshFromHost]);
  useLiveRefresh(detailQuery.refresh, {
    key: `lead:${reference.projectId}:${reference.repository}#${reference.number}`,
  });

  const comment = useAtomCommand(issueEnvironment.comment, { reportFailure: false });
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  const [commentDraft, setCommentDraft] = useState("");
  const [commentSending, setCommentSending] = useState(false);
  const [stateChanging, setStateChanging] = useState(false);
  const [handingOff, setHandingOff] = useState(false);

  const submitComment = async () => {
    const body = commentDraft.trim();
    if (body.length === 0 || commentSending) return;
    setCommentSending(true);
    const result = await comment({ environmentId, input: { ...reference, body: commentDraft } });
    setCommentSending(false);
    if (result._tag === "Failure") {
      // The draft stays with the words still in it: retyping is the one thing a failed send
      // must not cost.
      toastManager.add({
        type: "error",
        title: "The comment could not be posted",
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused the comment.",
        ),
      });
      return;
    }
    setCommentDraft("");
    refreshDetail();
    onActed?.();
  };

  const changeState = async (action: "close" | "reopen") => {
    if (stateChanging) return;
    setStateChanging(true);
    const result = await setState({ environmentId, input: { ...reference, action } });
    setStateChanging(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: action === "close" ? "Could not close this lead" : "Could not reopen this lead",
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused it. Check that you have write access, or that you opened it.",
        ),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: action === "close" ? "Lead closed" : "Lead reopened",
    });
    refreshDetail();
    onActed?.();
  };

  // Every project holding this repository, across every connected server: the copy the list
  // showed the lead under is where everything on this panel was read, but the work can start
  // wherever the reader keeps a checkout.
  const panelProject = projects.find(
    (project) => project.environmentId === environmentId && project.id === reference.projectId,
  );
  const repositoryKey = panelProject?.repositoryIdentity?.canonicalKey?.toLowerCase();
  const workProjects =
    repositoryKey === undefined
      ? panelProject === undefined
        ? []
        : [panelProject]
      : projects.filter(
          (project) => project.repositoryIdentity?.canonicalKey?.toLowerCase() === repositoryKey,
        );
  const environmentLabel = (id: string) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;

  const startWork = async (target: { environmentId: string; id: ProjectId }) => {
    if (detail === null || handingOff) return;
    setHandingOff(true);
    const opened = await openThreadWithTask(
      scopeProjectRef(target.environmentId as EnvironmentId, target.id),
      { prompt: buildLeadHandoffPrompt(detail) },
    );
    setHandingOff(false);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: "Could not open a thread",
        description: "Try again from the project, or open a thread first.",
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: "Lead handed to a thread",
      description: "The task is in the composer — read it over, then send.",
    });
  };

  const startWorkLabel = handingOff ? "Opening…" : "Start working on this";
  const startWorkButton =
    workProjects.length === 0 ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <span>
              <Button disabled size="sm" variant="default">
                <HammerIcon aria-hidden className="size-3.5" />
                {startWorkLabel}
              </Button>
            </span>
          }
        />
        <TooltipPopup side="bottom" className="max-w-72">
          No connected project holds this repository, so there is nowhere to start the work. Add the
          repository as a project first.
        </TooltipPopup>
      </Tooltip>
    ) : workProjects.length === 1 ? (
      <Button
        disabled={detail === null || handingOff}
        size="sm"
        variant="default"
        onClick={() => void startWork(workProjects[0]!)}
      >
        <HammerIcon aria-hidden className="size-3.5" />
        {startWorkLabel}
      </Button>
    ) : (
      <Menu>
        <MenuTrigger
          disabled={detail === null || handingOff}
          render={
            <Button size="sm" variant="default">
              <HammerIcon aria-hidden className="size-3.5" />
              {startWorkLabel}
              <ChevronDownIcon aria-hidden className="size-3.5" />
            </Button>
          }
        />
        <MenuPopup align="start" side="bottom">
          {workProjects.map((project) => (
            <MenuItem
              key={`${project.environmentId} ${project.id}`}
              onClick={() => void startWork(project)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{project.title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {environmentLabel(project.environmentId)}
                </span>
              </span>
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    );

  if (detail === null && detailQuery.error !== null) {
    return (
      <PullRequestsUnavailableState
        title="Could not load this lead"
        error={detailQuery.error}
        onRetry={refreshDetail}
      />
    );
  }
  if (detail === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <LoaderIcon aria-hidden className="mr-2 size-4 animate-spin" />
        Loading lead
      </div>
    );
  }

  const canClose = detail.viewerPermissions.actions.includes("close");
  const canReopen = detail.viewerPermissions.actions.includes("reopen");
  const stateButton =
    detail.state === "open" ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <span>
              <Button
                disabled={!canClose || stateChanging}
                size="sm"
                variant="outline"
                onClick={() => void changeState("close")}
              >
                <CheckCircle2Icon aria-hidden className="size-3.5" />
                Close
              </Button>
            </span>
          }
        />
        <TooltipPopup side="bottom" className="max-w-72">
          {canClose
            ? "Close this lead on the host."
            : "You need write access on this repository, or to have opened this issue, to close it."}
        </TooltipPopup>
      </Tooltip>
    ) : (
      <Tooltip>
        <TooltipTrigger
          render={
            <span>
              <Button
                disabled={!canReopen || stateChanging}
                size="sm"
                variant="outline"
                onClick={() => void changeState("reopen")}
              >
                <CircleDotIcon aria-hidden className="size-3.5" />
                Reopen
              </Button>
            </span>
          }
        />
        <TooltipPopup side="bottom" className="max-w-72">
          {canReopen
            ? "Reopen this lead on the host."
            : "You need write access on this repository, or to have opened this issue, to reopen it."}
        </TooltipPopup>
      </Tooltip>
    );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="space-y-3 border-b border-border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div
              className={cn(
                "flex items-center gap-1.5 text-xs font-medium",
                detail.state === "open"
                  ? "text-emerald-600 dark:text-emerald-300/90"
                  : "text-violet-600 dark:text-violet-300/90",
              )}
            >
              {detail.state === "open" ? (
                <CircleDotIcon aria-hidden className="size-3.5" />
              ) : (
                <CheckCircle2Icon aria-hidden className="size-3.5" />
              )}
              {detail.state === "open" ? "Open" : "Closed"}
            </div>
            <h2 className="mt-1 text-base font-semibold text-foreground">{detail.title}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>
                {detail.repository} #{detail.number}
              </span>
              <PullRequestActorLabel actor={detail.author} className="max-w-40" />
              <span>opened {formatRelativeTimeLabel(detail.createdAt)}</span>
              <a
                className="inline-flex items-center gap-0.5 hover:text-foreground"
                href={detail.url}
                rel="noreferrer noopener"
                target="_blank"
              >
                Open on GitHub
                <ArrowUpRightIcon aria-hidden className="size-3" />
              </a>
            </div>
          </div>
          <Button
            aria-label="Refresh"
            size="icon-sm"
            variant="ghost"
            onClick={() => void refreshFromHost()}
          >
            <RefreshCwIcon className={cn("size-3.5", detailQuery.isPending && "animate-spin")} />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {startWorkButton}
          {stateButton}
        </div>
      </div>

      <div className="flex min-h-0 flex-col gap-3 p-4">
        {detail.body.trim().length > 0 ? (
          <IssueMarkdown text={detail.body} />
        ) : (
          <p className="text-sm text-muted-foreground">No description.</p>
        )}

        <h3 className="mt-2 text-xs font-medium text-muted-foreground">
          {detail.commentCount === 1 ? "1 comment" : `${detail.commentCount} comments`}
        </h3>
        <div key={activityEpoch} className="flex flex-col gap-2">
          <LeadActivityPages environmentId={environmentId} reference={reference} />
        </div>

        <div className="mt-2 flex flex-col gap-2">
          <Textarea
            disabled={!detail.viewerPermissions.comment || commentSending}
            placeholder={
              detail.viewerPermissions.comment
                ? "Leave a comment"
                : "This conversation does not accept comments from this account."
            }
            rows={3}
            value={commentDraft}
            onChange={(event) => setCommentDraft(event.target.value)}
          />
          <Button
            className="self-end"
            disabled={
              !detail.viewerPermissions.comment ||
              commentSending ||
              commentDraft.trim().length === 0
            }
            size="sm"
            onClick={() => void submitComment()}
          >
            {commentSending ? "Posting…" : "Comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}
