import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SourceControlProviderKind } from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubIssueCli from "./GitHubIssueCli.ts";
import * as GitHubIssueProvider from "./GitHubIssueProvider.ts";
import type { IssueProviderApi } from "./IssueProvider.ts";

export class IssueProviderRegistry extends Context.Service<
  IssueProviderRegistry,
  {
    /** Null for a host with no implementation, which the service reports as unsupported. */
    readonly get: (kind: SourceControlProviderKind) => IssueProviderApi | null;
    readonly kinds: ReadonlyArray<SourceControlProviderKind>;
  }
>()("t3/issue/IssueProviderRegistry") {}

/** Exported for tests, which stand a registry up from providers they supply themselves. */
export function fromProviders(
  providers: ReadonlyArray<IssueProviderApi>,
): IssueProviderRegistry["Service"] {
  const byKind = new Map(providers.map((provider) => [provider.kind, provider]));
  return {
    get: (kind) => byKind.get(kind) ?? null,
    kinds: providers.map((provider) => provider.kind),
  };
}

/**
 * The hosts this build can read issues from: GitHub, and nothing else yet. GitLab, Bitbucket,
 * and Azure DevOps projects report as unsupported rather than missing, the way the pull-request
 * matrix explains them.
 */
const make = Effect.map(Effect.all([GitHubIssueProvider.make]), fromProviders);

/**
 * `GitHubGraphQlBudget` is deliberately NOT provided here: it is the workspace-wide GitHub
 * quota shared with the pull-request feature, and a layer of its own inside this registry
 * would race that one with independent accounting. The server provides the single shared
 * instance to both registries.
 */
export const layer = Layer.effect(IssueProviderRegistry, make).pipe(
  Layer.provide(GitHubIssueCli.layer.pipe(Layer.provide(GitHubCli.layer))),
);
