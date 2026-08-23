/**
 * Prompt context builders for thread and project summaries.
 *
 * Pure functions over read-model shapes so the reactor stays thin and the
 * truncation rules are testable without a database.
 *
 * @module summaryContext
 */
import type { OrchestrationProject, OrchestrationThread, ThreadSummary } from "@t3tools/contracts";

const MAX_MESSAGE_CHARS = 4_000;
const MAX_MESSAGES_SECTION_CHARS = 18_000;
const MAX_FIRST_USER_MESSAGE_CHARS = 2_000;
const MAX_ACTIVITY_LINES = 80;
const MAX_CHECKPOINT_FILES = 40;
const MAX_PROJECT_THREADS = 20;
const TRUNCATION_MARKER = "[Earlier content truncated]";

type SummaryThread = Pick<
  OrchestrationThread,
  "messages" | "activities" | "checkpoints" | "latestTurn" | "summary"
>;

export interface ThreadSummaryContext {
  readonly context: string;
  /** Set when the context is a delta over an existing summary. */
  readonly previousSummary: string | undefined;
  readonly basis: ThreadSummary["basis"];
  /** False when nothing worth summarising is in the selected window. */
  readonly hasContent: boolean;
}

function clipMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return `${text.slice(0, 2_500).trimEnd()}\n[…]\n${text.slice(-1_500).trimStart()}`;
}

function formatMessage(message: OrchestrationThread["messages"][number]): string | undefined {
  if (message.role === "system") return undefined;
  const text = message.text.trim();
  const attachments = (message.attachments ?? []).map((attachment) => attachment.name);
  const body = [
    ...(text.length > 0 ? [clipMessage(text)] : []),
    ...(attachments.length > 0 ? [`[Attachments: ${attachments.join(", ")}]`] : []),
  ].join("\n");
  return body.length > 0 ? `${message.role.toUpperCase()}:\n${body}` : undefined;
}

/**
 * Join message sections newest-last, keeping the first user message pinned
 * when the tail has to be cut so the model always sees what the thread set
 * out to do.
 */
function formatMessagesSection(
  messages: ReadonlyArray<OrchestrationThread["messages"][number]>,
  pinFirstUserMessage: boolean,
): string {
  const sections = messages.flatMap((message) => {
    const section = formatMessage(message);
    return section === undefined ? [] : [section];
  });
  const joined = sections.join("\n\n");
  if (joined.length <= MAX_MESSAGES_SECTION_CHARS) return joined;

  const firstUser = pinFirstUserMessage
    ? messages.find((message) => message.role === "user" && formatMessage(message))
    : undefined;
  const pinned = firstUser ? formatMessage(firstUser)!.slice(0, MAX_FIRST_USER_MESSAGE_CHARS) : "";
  const budget = MAX_MESSAGES_SECTION_CHARS - pinned.length - TRUNCATION_MARKER.length - 4;
  const tail = joined.slice(-budget);
  return [pinned, TRUNCATION_MARKER, tail].filter((part) => part.length > 0).join("\n\n");
}

function formatActivities(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
): string {
  const lines = activities
    .filter((activity) => activity.tone !== "info")
    .map((activity) => `- [${activity.tone}] ${activity.summary}`);
  const kept = lines.slice(-MAX_ACTIVITY_LINES);
  const dropped = lines.length - kept.length;
  return [...(dropped > 0 ? [`- [${dropped} earlier entries omitted]`] : []), ...kept].join("\n");
}

function formatCheckpoints(
  checkpoints: ReadonlyArray<OrchestrationThread["checkpoints"][number]>,
): string {
  const files = checkpoints.flatMap((checkpoint) =>
    checkpoint.files.map(
      (file) => `- ${file.path} (${file.kind}, +${file.additions}/-${file.deletions})`,
    ),
  );
  const kept = files.slice(-MAX_CHECKPOINT_FILES);
  const dropped = files.length - kept.length;
  return [...(dropped > 0 ? [`- [${dropped} earlier files omitted]`] : []), ...kept].join("\n");
}

/**
 * Build the model context for a thread summary. When the thread already has a
 * summary whose basis still fits the thread (no revert since), only the delta
 * is included and the previous summary is handed back for revision.
 */
export function buildThreadSummaryContext(thread: SummaryThread): ThreadSummaryContext {
  const previous = thread.summary ?? null;
  const deltaMode = previous !== null && previous.basis.messageCount <= thread.messages.length;

  // New messages plus any older message that kept streaming after the last
  // summary was written (the assistant reply is counted as soon as it starts).
  const messages = deltaMode
    ? thread.messages.filter(
        (message, index) =>
          index >= previous.basis.messageCount || message.updatedAt > previous.generatedAt,
      )
    : thread.messages;
  const activities = deltaMode
    ? thread.activities.filter((activity) => activity.createdAt > previous.generatedAt)
    : thread.activities;
  const checkpoints = deltaMode
    ? thread.checkpoints.filter((checkpoint) => checkpoint.completedAt > previous.generatedAt)
    : thread.checkpoints;

  const messagesSection = formatMessagesSection(messages, !deltaMode);
  const activitySection = formatActivities(activities);
  const checkpointSection = formatCheckpoints(checkpoints);

  const context = [
    ...(messagesSection.length > 0 ? [`Messages:\n${messagesSection}`] : []),
    ...(activitySection.length > 0 ? [`Agent activity:\n${activitySection}`] : []),
    ...(checkpointSection.length > 0 ? [`Files changed:\n${checkpointSection}`] : []),
  ].join("\n\n");

  return {
    context,
    previousSummary: deltaMode ? previous.text : undefined,
    basis: summaryBasis(thread),
    hasContent:
      messagesSection.length > 0 || activitySection.length > 0 || checkpointSection.length > 0,
  };
}

/** The thread state a summary describes; compared field by field by `isThreadSummaryCurrent`. */
function summaryBasis(thread: SummaryThread): ThreadSummary["basis"] {
  return {
    messageCount: thread.messages.length,
    turnId: thread.latestTurn?.turnId ?? null,
    activityCount: thread.activities.length,
    lastMessageAt: thread.messages.reduce<string | null>(
      (latest, message) =>
        latest === null || message.updatedAt > latest ? message.updatedAt : latest,
      null,
    ),
  };
}

/** True when the thread has nothing new since its current summary was written. */
export function isThreadSummaryCurrent(thread: SummaryThread): boolean {
  const summary = thread.summary;
  if (!summary) return false;
  const current = summaryBasis(thread);
  return (
    summary.basis.messageCount === current.messageCount &&
    summary.basis.turnId === current.turnId &&
    (summary.basis.activityCount ?? current.activityCount) === current.activityCount &&
    (summary.basis.lastMessageAt ?? current.lastMessageAt) === current.lastMessageAt
  );
}

type ProjectSummaryThread = Pick<
  OrchestrationThread,
  "title" | "branch" | "latestTurn" | "summary" | "updatedAt" | "archivedAt" | "deletedAt"
>;

/**
 * Build the model context for a project summary from its active threads,
 * most recently updated first.
 */
export function buildProjectSummaryContext(input: {
  readonly project: Pick<OrchestrationProject, "title">;
  readonly threads: ReadonlyArray<ProjectSummaryThread>;
}): { readonly context: string; readonly hasContent: boolean } {
  const active = input.threads
    .filter((thread) => thread.archivedAt === null && thread.deletedAt === null)
    .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const kept = active.slice(0, MAX_PROJECT_THREADS);
  const sections = kept.map((thread) =>
    [
      `## ${thread.title}`,
      ...(thread.branch ? [`Branch: ${thread.branch}`] : []),
      `State: ${thread.latestTurn?.state ?? "no turns yet"}`,
      `Last activity: ${thread.updatedAt}`,
      `Summary: ${thread.summary?.text ?? "(none yet)"}`,
    ].join("\n"),
  );
  const dropped = active.length - kept.length;
  const context = [
    ...sections,
    ...(dropped > 0 ? [`(${dropped} older threads omitted)`] : []),
  ].join("\n\n");
  return { context, hasContent: kept.length > 0 };
}
