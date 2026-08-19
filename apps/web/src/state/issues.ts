import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import type { IssueListInput } from "@t3tools/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { mergeIssueLists, type MergedIssueList } from "../components/leads/leadsList.logic";
import { createMergedEnvironmentQuery, type EnvironmentQueryTarget } from "./pullRequests";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

const useIssueListsQuery = createMergedEnvironmentQuery("web-issues:list", issueEnvironment.list);

export interface MergedIssueListView {
  readonly data: MergedIssueList | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

/** One listing per environment, merged into the single list the Leads page renders. */
export function useIssueList(
  targets: ReadonlyArray<EnvironmentQueryTarget<IssueListInput>>,
): MergedIssueListView {
  const query = useIssueListsQuery(targets);
  const data = useMemo(() => mergeIssueLists(query.values), [query.values]);
  return { data, error: query.error, isPending: query.isPending, refresh: query.refresh };
}
