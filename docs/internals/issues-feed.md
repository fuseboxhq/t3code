# Issues feed

The issues feed is the data layer behind the Leads surface: GitHub issues from every project's repository, read through the same architecture as the pull-request workspace.
It is a cached pull-through to the host, not event-sourced state.

## Shape

The feed mirrors the pull-request feature file for file, one directory over:

- `packages/contracts/src/issue.ts` - wire schemas.
  The model is issue-shaped, not lead-shaped: a Lead is an issue wearing the `lead` label, and clients pin that through the ordinary label filter.
- `apps/server/src/issue/IssueProvider.ts` - the neutral port.
  GitHub is the only implementation; other hosts report as unsupported, the way the pull-request matrix explains them.
- `apps/server/src/issue/GitHubIssueCli.ts` and `gitHubIssueJson.ts` - the `gh` adapter.
  Reads share the pull-request feature's escaping (`searchPhrase`, `qualifierValue`, repository-selector validation) so a crafted label or search phrase cannot smuggle qualifiers, and reader-supplied values travel over stdin, never argv.
- `apps/server/src/issue/IssueService.ts` - orchestration: project resolution from the projected shell, epoch-invalidated caches (30s list / 15s detail, stale-while-revalidate behind them), per-host viewer resolution, and server-side permission rechecks before every mutation.
- `packages/client-runtime/src/state/issues.ts` - SWR query atoms and serial-per-environment commands.

Auth is whatever `gh` is signed in as; no tokens are stored.
The `issues` capability flag on the environment descriptor gates clients, and is absent on older servers.

## Listing and pagination

Listing is one GraphQL search per host batch: repositories sorted and chunked (100 per search, GitHub's page ceiling), `is:issue` plus label/state/author qualifiers, `sort:updated-desc`.
Continuation uses GitHub's own opaque `endCursor`, wrapped as `v1|<membership fingerprint>|<endCursor>` and keyed by batch (`<host> #<n>`).
The fingerprint freezes chunk membership for the life of a cursor chain: a workspace whose project set changed refuses the cursor rather than quietly skipping rows.
There is deliberately no `limit+1` probe row - a positional cursor stands exactly after the last row served, so a fetched-and-sliced row would be lost; `hasNextPage` answers "is there more" instead.

A repository the search index answers with silence (renamed repositories do this) is read once on its own through `gh issue list` before the silence is believed, first slice only.

## The shared GitHub quota

`GitHubGraphQlBudget` used to be provided privately inside `PullRequestProviderRegistry.layer`.
It is now hoisted: both provider registries require it, and `server.ts` provides one `sourceControlQuotaLayer` (budget plus `SourceControlRateLimit`) by reference to both service graphs, which layer memoization turns into single shared instances.
The point of the hoist is that the pull-request page and the Leads page draw on the same host quotas with one set of accounting - `issueQuotaSharing.test.ts` proves an issue read's observed quota pauses the next pull-request read.

## Known v1 simplifications

- Legacy repository identities with `provider: "unknown"` are not refined here (the pull-request service does refine them); such projects report as unsupported until their identity is re-resolved.
- The per-repository fallback read reports no comment counts (`commentCount` is optional on list entries) because counting without fetching needs the search API.
