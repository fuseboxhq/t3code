import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import type {
  EnvironmentId,
  IssueListCursors,
  IssueListInput,
  IssueListState,
  ProjectId,
} from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  CheckCircle2Icon,
  CircleDotIcon,
  FolderGit2Icon,
  LayersIcon,
  LoaderIcon,
  RefreshCwIcon,
  TargetIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LeadDetailPanel } from "../components/leads/LeadDetailPanel";
import { LeadRow } from "../components/leads/LeadRow";
import { showLeadRowContextMenu } from "../components/leads/leadRowContextMenu";
import {
  LEAD_LABEL,
  LEAD_LIST_PAGE_SIZE,
  buildLeadHandoffPrompt,
  buildLeadListFilters,
  groupLeadsByProject,
  issueEntryKey,
  matchesLeadQuery,
  parseLeadQuery,
  type EnvironmentIssueEntry,
  type MergedIssueList,
} from "../components/leads/leadsList.logic";
import { assignEnvironmentProjectQueries } from "../components/pullRequest/pullRequestProjectAssignment.logic";
import {
  findScopedProject,
  resolveProjectScope,
  resolveQueryEnvironmentIds,
} from "../components/pullRequest/pullRequestList.logic";
import { PullRequestListGhost } from "../components/pullRequest/PullRequestGhosts";
import { PullRequestSearchInput } from "../components/pullRequest/PullRequestListFilters";
import { PullRequestsUnavailableState } from "../components/pullRequest/PullRequestsUnavailableState";
import { RightPanelTabs } from "../components/RightPanelTabs";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { PanelLayoutControls } from "../components/chat/PanelLayoutControls";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { useComposerHandoff } from "../hooks/useComposerHandoff";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import {
  selectActiveRightPanelSurface,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
  type LeadSurface,
} from "../rightPanelStore";
import { useDebouncedValue } from "../state/queries";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { issueEnvironment, useIssueList } from "../state/issues";
import { useAtomCommand } from "../state/use-atom-command";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

// Exported for the generated route tree's typing, the way the pull-request page's search is.
export interface LeadsSearch {
  readonly state: IssueListState;
  readonly q?: string;
  /** Scopes the list to one project's repository, the way the pull-request page's scope does. */
  readonly projectId?: ProjectId;
  readonly repository?: string;
  readonly number?: number;
  readonly selectedProjectId?: ProjectId;
  readonly selectedEnvironmentId?: EnvironmentId;
}

const STATE_TABS = [
  { value: "open", label: "Open", Icon: CircleDotIcon },
  { value: "closed", label: "Closed", Icon: CheckCircle2Icon },
  { value: "all", label: "All", Icon: LayersIcon },
] as const satisfies ReadonlyArray<{
  value: IssueListState;
  label: string;
  Icon: typeof LayersIcon;
}>;

const SEARCH_DEBOUNCE_MS = 250;
/** The feed's first-page size, shared with the sidebar's counts so both read one cached answer. */
const PAGE_SIZE = LEAD_LIST_PAGE_SIZE;
/** The largest page the listing accepts; past it the request is refused outright. */
const MAX_PAGE_SIZE = 500;
/** The list owns one environment-scoped right panel rather than borrowing a real thread's. */
const LEADS_PANEL_ID = ThreadId.make("leads-panel");
/** A fixed sentinel, not a real server, for the reason the pull-request page gives. */
const LEADS_PANEL_ENVIRONMENT_ID = "leads-panel" as EnvironmentId;
const EMPTY_PREVIEW_SESSIONS = {};
const EMPTY_PREVIEW_DESKTOP_STATE = {};
const EMPTY_TERMINAL_LABELS = new Map<string, string>();
const EMPTY_PENDING_SURFACES = new Set<string>();

export const Route = createFileRoute("/_chat/leads")({
  validateSearch: (raw: Record<string, unknown>): LeadsSearch => ({
    state: raw.state === "closed" || raw.state === "all" ? raw.state : "open",
    ...(typeof raw.q === "string" && raw.q ? { q: raw.q.slice(0, 200) } : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.repository === "string" && raw.repository
      ? { repository: raw.repository.slice(0, 200) }
      : {}),
    ...(typeof raw.number === "number" && Number.isInteger(raw.number) && raw.number > 0
      ? { number: raw.number }
      : {}),
    ...(typeof raw.selectedProjectId === "string" && raw.selectedProjectId
      ? { selectedProjectId: raw.selectedProjectId as ProjectId }
      : {}),
    ...(typeof raw.selectedEnvironmentId === "string" && raw.selectedEnvironmentId
      ? { selectedEnvironmentId: raw.selectedEnvironmentId as EnvironmentId }
      : {}),
  }),
  component: LeadsRouteView,
});

function LeadsRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { environments } = useEnvironments();
  const capableEnvironments = useMemo(
    () =>
      environments
        .filter((environment) => environment.serverConfig?.environment.capabilities.issues === true)
        .toSorted((left, right) => left.environmentId.localeCompare(right.environmentId)),
    [environments],
  );
  const environmentIds = useMemo(
    () => capableEnvironments.map((environment) => environment.environmentId),
    [capableEnvironments],
  );
  // Until at least one server has reported, an empty set means "not known yet" rather than "no
  // environment can", and the page waits rather than telling a reader to upgrade.
  const capabilityKnown = environments.some((environment) => environment.serverConfig !== null);
  const leadsSupported = environmentIds.length > 0;
  const allProjects = useProjects();
  const projectsKnown = useAllEnvironmentShellsBootstrapped();
  const projects = useMemo(
    () => allProjects.filter((project) => environmentIds.includes(project.environmentId)),
    [allProjects, environmentIds],
  );
  const environmentLabels = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );

  const updateSearch = useCallback(
    (patch: { [Key in keyof LeadsSearch]?: LeadsSearch[Key] | undefined }) =>
      void navigate({
        search: (previous: LeadsSearch): LeadsSearch => {
          const next = { ...previous, ...patch };
          return {
            state: next.state ?? previous.state,
            ...(next.q ? { q: next.q } : {}),
            ...(next.projectId ? { projectId: next.projectId } : {}),
            ...(next.repository ? { repository: next.repository } : {}),
            ...(next.number ? { number: next.number } : {}),
            ...(next.selectedProjectId ? { selectedProjectId: next.selectedProjectId } : {}),
            ...(next.selectedEnvironmentId
              ? { selectedEnvironmentId: next.selectedEnvironmentId }
              : {}),
          };
        },
        replace: true,
      }),
    [navigate],
  );
  const clearedSelection = {
    repository: undefined,
    number: undefined,
    selectedProjectId: undefined,
    selectedEnvironmentId: undefined,
  };

  // One panel for the page; surfaces carry the server they were read from. The sentinel keeps
  // the tab strip alive across a capable server disconnecting.
  const rightPanelRef = useMemo(
    () =>
      capableEnvironments.length === 0
        ? null
        : scopeThreadRef(LEADS_PANEL_ENVIRONMENT_ID, LEADS_PANEL_ID),
    [capableEnvironments.length],
  );
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, rightPanelRef),
  );
  const selectedRightPanelSurface = useRightPanelStore((state) =>
    selectSelectedRightPanelSurface(state.byThreadKey, rightPanelRef),
  );
  const selectedLeadSurface =
    selectedRightPanelSurface?.kind === "lead" ? selectedRightPanelSurface : null;
  const activeLeadSurface = rightPanelState.isOpen ? selectedLeadSurface : null;

  const typedQuery = (search.q ?? "").trim();
  const sentQuery = useDebouncedValue(typedQuery, SEARCH_DEBOUNCE_MS);
  const querySettled = typedQuery === sentQuery;
  // Typed qualifiers become host-side filters; free text alone only searches what GitHub's
  // text index covers, so `label:`/`author:` must travel as filters to match beyond the rows
  // already loaded.
  const sentParsed = useMemo(() => parseLeadQuery(sentQuery), [sentQuery]);
  const sentFilters = useMemo(() => buildLeadListFilters(sentParsed), [sentParsed]);

  // The scope the URL asks for, once the environments have had their say about whether it
  // exists — an id no connected server holds falls back to the whole list, the way the
  // pull-request page's scope does.
  const scopedProjectId = useMemo(
    () => resolveProjectScope(search.projectId, projects, projectsKnown),
    [projects, projectsKnown, search.projectId],
  );
  const scopedProject = useMemo(
    () => findScopedProject(projects, null, scopedProjectId),
    [projects, scopedProjectId],
  );
  // An ambiguous id — two servers, one project name — still shows a chip: any holder's title
  // names the repository being filtered to.
  const scopedProjectTitle =
    scopedProject?.title ??
    projects.find((project) => project.id === scopedProjectId)?.title ??
    "One project";
  const queryEnvironmentIds = useMemo(
    () =>
      resolveQueryEnvironmentIds(
        environmentIds,
        projects,
        scopedProject,
        scopedProjectId,
        projectsKnown,
      ),
    [environmentIds, projects, projectsKnown, scopedProject, scopedProjectId],
  );
  // Which projects each server is asked about: two servers holding the same repository would
  // both list the same leads, so each repository is listed by one of them. A scoped list asks
  // plainly — the scope itself is the narrowing.
  const environmentQueries = useMemo((): ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectIds?: ReadonlyArray<ProjectId>;
  }> => {
    if (!projectsKnown || scopedProjectId !== undefined) {
      return queryEnvironmentIds.map((environmentId) => ({ environmentId }));
    }
    return assignEnvironmentProjectQueries(projects, queryEnvironmentIds);
  }, [projects, projectsKnown, queryEnvironmentIds, scopedProjectId]);

  const assignmentKey = useMemo(
    () =>
      environmentQueries
        .map(({ environmentId, projectIds }) => `${environmentId}#${projectIds?.join("+") ?? "*"}`)
        .join("|"),
    [environmentQueries],
  );
  // The scope is the question; the query narrows it. Split so carried rows can tell "same
  // question, new search" apart from "different question entirely".
  const scopeKey = `${assignmentKey}:${search.state}:${scopedProjectId ?? ""}`;
  const filterKey = `${scopeKey}:${sentQuery}`;

  // Where the next slice carries on from, per environment, exactly as it was handed back -
  // plus the page size a refresh re-reads at, grown to cover everything already on screen.
  const [page, setPage] = useState<{
    key: string;
    size: number;
    cursors: Readonly<Record<string, IssueListCursors>> | null;
  }>({ key: filterKey, size: PAGE_SIZE, cursors: null });
  const pageSize = page.key === filterKey ? page.size : PAGE_SIZE;
  const sentCursors = page.key === filterKey ? page.cursors : null;
  useEffect(() => {
    setPage({ key: filterKey, size: PAGE_SIZE, cursors: null });
  }, [filterKey]);

  const listTargets = useMemo(
    () =>
      environmentQueries.flatMap(({ environmentId, projectIds }) => {
        const cursors = sentCursors?.[environmentId];
        // A continuation asks only the environments that said where to carry on from.
        if (sentCursors !== null && cursors === undefined) return [];
        return [
          {
            environmentId,
            input: {
              state: search.state,
              filters: sentFilters,
              limit: pageSize,
              ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
              ...(projectIds ? { projectIds } : {}),
              ...(sentParsed.text ? { query: sentParsed.text } : {}),
              ...(cursors === undefined ? {} : { cursors }),
            } satisfies IssueListInput,
          },
        ];
      }),
    [
      environmentQueries,
      pageSize,
      scopedProjectId,
      search.state,
      sentCursors,
      sentFilters,
      sentParsed.text,
    ],
  );
  const listQuery = useIssueList(listTargets);

  // The last answer for this question, held so the page narrows and grows in place rather than
  // blanking for every round trip; a continuation appends below what is already on screen.
  const [loaded, setLoaded] = useState<{
    key: string;
    scope: string;
    data: MergedIssueList;
    entries: ReadonlyArray<EnvironmentIssueEntry>;
  } | null>(null);
  useEffect(() => {
    if (listQuery.data === null || listQuery.isPending) return;
    const data = listQuery.data;
    setLoaded((previous) => {
      if (previous === null || previous.key !== filterKey || sentCursors === null) {
        return { key: filterKey, scope: scopeKey, data, entries: data.entries };
      }
      // A continuation's rows land under the ones on screen - and a row the slice carries
      // again replaces the one being shown, so a comment count or state that moved between
      // pages is not frozen at its first reading.
      const arrivedByKey = new Map(data.entries.map((entry) => [issueEntryKey(entry), entry]));
      const kept = previous.entries.map((entry) => {
        const key = issueEntryKey(entry);
        const replacement = arrivedByKey.get(key);
        if (replacement !== undefined) arrivedByKey.delete(key);
        return replacement ?? entry;
      });
      return {
        key: filterKey,
        scope: scopeKey,
        data,
        entries: [...kept, ...arrivedByKey.values()],
      };
    });
  }, [filterKey, listQuery.data, listQuery.isPending, scopeKey, sentCursors]);

  const answered = loaded?.key === filterKey ? loaded : null;
  // Rows from the previous question are carried only as far as they can be narrowed honestly:
  // the same scope's rows through a search swap, or the previous state's rows narrowed to the
  // new state. A different environment split drops them outright - one of those servers may no
  // longer be connected - and rows that narrow to nothing leave the skeletons to be right.
  const carried = useMemo(() => {
    if (loaded === null) return null;
    if (loaded.scope === scopeKey) return loaded;
    if (!loaded.scope.startsWith(`${assignmentKey}:`)) return null;
    const entries = loaded.entries.filter(
      (entry) => search.state === "all" || entry.state === search.state,
    );
    return entries.length === 0 ? null : { ...loaded, entries };
  }, [assignmentKey, loaded, scopeKey, search.state]);
  const listData = (answered ?? carried)?.data ?? null;
  const knownEntries = (answered ?? carried)?.entries ?? [];
  const firstLoad = listQuery.isPending && answered === null && carried === null;
  const loadingMore = listQuery.isPending && answered !== null;

  // The local pass over rows already on screen while the hosts' own answer travels; once it has
  // landed, the hosts searched more than the row shows, so their answer stands unnarrowed.
  const entries = useMemo(() => {
    if (typedQuery.length === 0) return knownEntries;
    if (querySettled && answered !== null) return knownEntries;
    return knownEntries.filter((entry) => matchesLeadQuery(entry, typedQuery));
  }, [answered, knownEntries, querySettled, typedQuery]);
  const groups = useMemo(() => groupLeadsByProject(entries), [entries]);

  const invalidate = useAtomCommand(issueEnvironment.invalidate, { reportFailure: false });
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const [invalidating, setInvalidating] = useState(false);
  // A refresh means the whole visible list again, and a cursored query cannot answer that: it
  // re-reads only its own slice. Going back to a single page long enough to cover everything on
  // screen lets the replace-by-key merge above bring every loaded row up to date in place.
  // Capped at the listing's own maximum, the same trade the pull-request page makes: past 500
  // loaded rows a refresh keeps the newest 500 and the rest are re-reached by loading more.
  const refreshList = () => {
    if (sentCursors === null) {
      listQuery.refresh();
      return;
    }
    const loadedCount = answered?.entries.length ?? pageSize;
    setPage({
      key: filterKey,
      cursors: null,
      size: Math.min(
        Math.max(pageSize, Math.ceil(loadedCount / PAGE_SIZE) * PAGE_SIZE),
        MAX_PAGE_SIZE,
      ),
    });
  };
  const refreshFromHost = async () => {
    setInvalidating(true);
    try {
      // Only the servers the scoped list actually asks; a scoped refresh should not purge the
      // cache of a server whose answer is not on screen.
      await Promise.all(
        queryEnvironmentIds.map((environmentId) => invalidate({ environmentId, input: {} })),
      );
    } finally {
      setInvalidating(false);
    }
    refreshList();
    setDetailRefreshToken((token) => token + 1);
  };
  const refreshing = invalidating || listQuery.isPending;
  useLiveRefresh(() => refreshList(), { enabled: leadsSupported });

  const nextCursors = answered?.data.nextCursors ?? {};
  const canLoadMore = Object.keys(nextCursors).length > 0;
  const loadMore = () => {
    if (!canLoadMore) return;
    setPage({ key: filterKey, size: pageSize, cursors: nextCursors });
  };

  // A link that names a lead opens it; a row press writes the link. The two stay in step so a
  // shared URL and a click land on the same panel.
  const selectSurfaceInUrl = (surface: LeadSurface | null) =>
    updateSearch(
      surface === null
        ? clearedSelection
        : {
            repository: surface.repository,
            number: surface.number,
            selectedProjectId: surface.projectId as ProjectId,
            ...(surface.environmentId === undefined
              ? {}
              : { selectedEnvironmentId: surface.environmentId as EnvironmentId }),
          },
    );
  const linkedSelection = useMemo(() => {
    if (!search.repository || !search.number) return null;
    const environmentId =
      search.selectedEnvironmentId !== undefined &&
      environmentIds.includes(search.selectedEnvironmentId)
        ? search.selectedEnvironmentId
        : null;
    const projectId =
      search.selectedProjectId !== undefined &&
      projects.some(
        (project) =>
          project.id === search.selectedProjectId &&
          (environmentId === null || project.environmentId === environmentId),
      )
        ? search.selectedProjectId
        : null;
    if (environmentId === null || projectId === null) return null;
    return {
      environmentId,
      projectId,
      repository: search.repository,
      number: search.number,
    };
  }, [environmentIds, projects, search]);
  useEffect(() => {
    if (!leadsSupported || rightPanelRef === null || linkedSelection === null) return;
    useRightPanelStore.getState().openLead(rightPanelRef, linkedSelection);
  }, [leadsSupported, linkedSelection, rightPanelRef]);

  const { openThreadWithTask } = useComposerHandoff();
  // One hand-off at a time: the menu closes on the press, and a second press mid-flight would
  // open a second draft over the first.
  const leadWorkInFlight = useRef(false);
  // The row's shortcut to a thread: the same hand-off as the panel button, with the checkout
  // decision made by which menu entry was pressed. No issue body here — the row does not carry
  // one — so the prompt tells the agent to read the issue first.
  const startLeadWork = useCallback(
    async (entry: EnvironmentIssueEntry, mode: "worktree" | "local") => {
      if (leadWorkInFlight.current) return;
      leadWorkInFlight.current = true;
      try {
        const opened = await openThreadWithTask(
          scopeProjectRef(entry.environmentId, entry.projectId),
          {
            prompt: buildLeadHandoffPrompt({
              title: entry.title,
              url: entry.url,
              number: entry.number,
              repository: entry.repository,
              body: "",
            }),
          },
          { envMode: mode },
        );
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
          description:
            mode === "worktree"
              ? "The task is in the composer, set to run in a fresh worktree — read it over, then send."
              : "The task is in the composer, set to run in the current checkout — read it over, then send.",
        });
      } finally {
        leadWorkInFlight.current = false;
      }
    },
    [openThreadWithTask],
  );
  const handleRowContextMenu = useCallback(
    (entry: EnvironmentIssueEntry, position: { x: number; y: number }) => {
      void showLeadRowContextMenu({
        url: entry.url,
        position,
        onStart: (mode) => void startLeadWork(entry, mode),
      });
    },
    [startLeadWork],
  );

  const selectEntry = useCallback(
    (entry: EnvironmentIssueEntry) => {
      if (rightPanelRef === null) return;
      useRightPanelStore.getState().openLead(rightPanelRef, entry);
      updateSearch({
        repository: entry.repository,
        number: entry.number,
        selectedProjectId: entry.projectId,
        selectedEnvironmentId: entry.environmentId,
      });
    },
    [rightPanelRef, updateSearch],
  );

  const activateSurface = (surface: LeadSurface) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().activateSurface(rightPanelRef, surface.id);
    selectSurfaceInUrl(surface);
  };
  const closeSurface = (surface: LeadSurface) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeSurface(rightPanelRef, surface.id);
    const next = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      rightPanelRef,
    );
    selectSurfaceInUrl(next?.kind === "lead" ? next : null);
  };
  const closeAllSurfaces = () => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeAllSurfaces(rightPanelRef);
    selectSurfaceInUrl(null);
  };
  // Changing what the list contains must not leave a selection from the previous view open.
  const changeListState = (state: IssueListState) => {
    if (rightPanelRef !== null) {
      useRightPanelStore.getState().close(rightPanelRef);
    }
    updateSearch({ state, ...clearedSelection });
  };

  const toggleRightPanel = () => {
    if (rightPanelRef === null) return;
    if (rightPanelState.isOpen) {
      useRightPanelStore.getState().close(rightPanelRef);
      updateSearch(clearedSelection);
      return;
    }
    if (selectedLeadSurface === null) return;
    useRightPanelStore.getState().show(rightPanelRef);
    selectSurfaceInUrl(selectedLeadSurface);
  };

  const selected = activeLeadSurface;
  const panelEnvironmentId =
    (activeLeadSurface?.environmentId as EnvironmentId | undefined) ?? null;

  // Every host unauthenticated or unreadable, and nothing to show, is a page-level state with
  // the remediation the server already spelled out — not an empty list.
  const unconfiguredDetail =
    listData !== null &&
    entries.length === 0 &&
    listData.providers.length > 0 &&
    listData.providers.every((provider) => !provider.configured)
      ? (listData.providers.find((provider) => provider.detail !== null)?.detail ??
        "No host could be read.")
      : null;

  const listBody = (
    <>
      {!capabilityKnown ? (
        <PullRequestListGhost rows={7} caption="Loading leads" />
      ) : !leadsSupported ? (
        <PullRequestsUnavailableState
          title="Leads unavailable"
          error="Update your T3 Code servers to browse leads."
        />
      ) : firstLoad ? (
        <PullRequestListGhost rows={7} caption="Loading leads" />
      ) : listQuery.error !== null && listData === null ? (
        <PullRequestsUnavailableState
          title="Could not load leads"
          error={listQuery.error}
          onRetry={() => listQuery.refresh()}
        />
      ) : unconfiguredDetail !== null ? (
        <PullRequestsUnavailableState title="Leads unavailable" error={unconfiguredDetail} />
      ) : entries.length === 0 ? (
        <Empty className="px-4 py-16 md:px-4">
          <EmptyMedia variant="icon">
            <TargetIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{typedQuery.length > 0 ? "No matching leads" : "No leads"}</EmptyTitle>
            <EmptyDescription>
              {typedQuery.length > 0
                ? "Nothing here matches the search."
                : search.state === "open"
                  ? `Nothing carries the "${LEAD_LABEL}" label in your projects right now. Agents raise leads as they work; new ones appear here.`
                  : "Nothing here in this state."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.key} className="space-y-0.5">
              <h2 className="px-3 pb-0.5 text-xs font-medium text-muted-foreground/70">
                {group.projectTitle}
              </h2>
              {group.entries.map((entry) => (
                <LeadRow
                  key={issueEntryKey(entry)}
                  entry={entry}
                  selected={
                    selected?.environmentId === entry.environmentId &&
                    selected.repository === entry.repository &&
                    selected.number === entry.number
                  }
                  {...(capableEnvironments.length > 1 &&
                  environmentLabels.get(entry.environmentId) !== undefined
                    ? { environmentLabel: environmentLabels.get(entry.environmentId)! }
                    : {})}
                  onSelect={selectEntry}
                  onContextMenu={handleRowContextMenu}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {listData !== null && listData.errors.length > 0 ? (
        <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
          {listData.errors.map((error) => (
            <p key={`${error.environmentId} ${error.projectId}`}>{error.message}</p>
          ))}
        </div>
      ) : null}
      {listQuery.error !== null && listData !== null ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
          <span>The latest request failed. Showing the last leads loaded.</span>
          <Button size="xs" variant="outline" onClick={() => listQuery.refresh()}>
            Retry
          </Button>
        </div>
      ) : null}
      {canLoadMore && entries.length > 0 ? (
        <div className="flex justify-center py-2">
          <Button disabled={loadingMore} size="sm" variant="outline" onClick={loadMore}>
            {loadingMore ? (
              <>
                <LoaderIcon aria-hidden className="size-3.5 animate-spin" />
                Loading more
              </>
            ) : (
              "Load more"
            )}
          </Button>
        </div>
      ) : null}
    </>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="relative flex min-h-0 flex-1">
        {leadsSupported ? (
          <div
            className="absolute top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]"
            data-workspace-titlebar-controls
          >
            <PanelLayoutControls
              showTerminalControl={false}
              terminalAvailable={false}
              terminalOpen={false}
              terminalShortcutLabel={null}
              rightPanelAvailable={rightPanelState.surfaces.length > 0}
              rightPanelOpen={rightPanelState.isOpen}
              rightPanelShortcutLabel={null}
              liveAgentCount={0}
              onToggleTerminal={() => undefined}
              onToggleRightPanel={toggleRightPanel}
            />
          </div>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <header
            className={cn(
              "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1.5 px-3 sm:px-5",
              !rightPanelState.isOpen && "wco:pr-[var(--workspace-native-controls-inset)]",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <WorkspaceBreadcrumb ariaLabel="Leads breadcrumb">
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">Leads</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="min-w-0 flex-1" />
            <Button
              aria-label="Refresh leads"
              size="icon-sm"
              variant="ghost"
              onClick={() => void refreshFromHost()}
            >
              <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} />
            </Button>
            {!leadsSupported || rightPanelState.isOpen ? null : (
              <span aria-hidden className="w-7 shrink-0 sm:w-5" />
            )}
          </header>

          <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto [--topbar-scroll-fade-height:1.5rem]">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-5 pt-6 pb-12">
              <div className="flex items-center gap-2">
                <PullRequestSearchInput
                  value={search.q ?? ""}
                  busy={typedQuery.length > 0 && !querySettled}
                  placeholder="Search leads"
                  ariaLabel="Search leads"
                  onChange={(query) => updateSearch({ q: query || undefined })}
                />
                {scopedProjectId !== undefined ? (
                  <Button
                    size="xs"
                    variant="secondary"
                    className="max-w-48 shrink-0"
                    aria-label={`Stop filtering to ${scopedProjectTitle}`}
                    title={`Filtered to ${scopedProjectTitle} — click to clear`}
                    onClick={() => updateSearch({ projectId: undefined })}
                  >
                    <FolderGit2Icon aria-hidden className="size-3.5 shrink-0" />
                    <span className="truncate">{scopedProjectTitle}</span>
                    <XIcon aria-hidden className="size-3 shrink-0 opacity-60" />
                  </Button>
                ) : null}
                <div className="flex shrink-0 items-center gap-1" role="group" aria-label="State">
                  {STATE_TABS.map((tab) => (
                    <Button
                      key={tab.value}
                      aria-pressed={search.state === tab.value}
                      size="xs"
                      variant={search.state === tab.value ? "secondary" : "ghost"}
                      onClick={() => changeListState(tab.value)}
                    >
                      <tab.Icon aria-hidden className="size-3.5" />
                      {tab.label}
                    </Button>
                  ))}
                </div>
              </div>

              {listBody}
            </div>
          </div>
        </div>

        {rightPanelState.isOpen && activeLeadSurface && panelEnvironmentId !== null ? (
          <RightPanelTabs
            mode="inline"
            widthStorageKey="t3code:leads-panel-width"
            defaultWidth={typeof window === "undefined" ? 640 : Math.floor(window.innerWidth / 2)}
            surfaces={rightPanelState.surfaces}
            activeSurfaceId={activeLeadSurface.id}
            environmentId={panelEnvironmentId}
            pendingSurfaceIds={EMPTY_PENDING_SURFACES}
            previewSessions={EMPTY_PREVIEW_SESSIONS}
            desktopByTabId={EMPTY_PREVIEW_DESKTOP_STATE}
            terminalLabelsById={EMPTY_TERMINAL_LABELS}
            onActivate={(surface) => {
              if (surface.kind === "lead") activateSurface(surface);
            }}
            onCloseSurface={(surface) => {
              if (surface.kind === "lead") closeSurface(surface);
            }}
            onCloseOtherSurfaces={(surface) => {
              if (surface.kind !== "lead" || rightPanelRef === null) return;
              useRightPanelStore.getState().closeOtherSurfaces(rightPanelRef, surface.id);
              selectSurfaceInUrl(surface);
            }}
            onCloseSurfacesToRight={(surface) => {
              if (surface.kind !== "lead" || rightPanelRef === null) return;
              useRightPanelStore.getState().closeSurfacesToRight(rightPanelRef, surface.id);
              const next = selectActiveRightPanelSurface(
                useRightPanelStore.getState().byThreadKey,
                rightPanelRef,
              );
              selectSurfaceInUrl(next?.kind === "lead" ? next : null);
            }}
            onCloseAllSurfaces={closeAllSurfaces}
            onCopyFilePath={() => undefined}
            onAddBrowser={() => undefined}
            onAddBrowserInProfile={() => undefined}
            onAddTerminal={() => undefined}
            onAddDiff={() => undefined}
            onAddFiles={() => undefined}
            onAddPullRequest={() => undefined}
            onAddAgents={() => undefined}
            browserAvailable={false}
            terminalAvailable={false}
            diffAvailable={false}
            filesAvailable={false}
            pullRequestAvailable={false}
            agentsAvailable={false}
            liveAgentCount={0}
          >
            <LeadDetailPanel
              key={activeLeadSurface.id}
              environmentId={panelEnvironmentId}
              reference={{
                projectId: activeLeadSurface.projectId as ProjectId,
                repository: activeLeadSurface.repository,
                number: activeLeadSurface.number,
              }}
              refreshToken={detailRefreshToken}
              onActed={refreshList}
            />
          </RightPanelTabs>
        ) : null}
      </div>
    </SidebarInset>
  );
}
