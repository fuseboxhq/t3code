/**
 * Pure helpers behind the `thread_*` MCP tools: picking a model for a spawned
 * sub-thread and collapsing a thread's session/turn/message state into the
 * coarse view an orchestrating agent needs.
 */
import {
  DEFAULT_MODEL_BY_PROVIDER,
  isProviderAvailable,
  type AgentThreadSpawnInput,
  type AgentThreadState,
  type AgentThreadSummary,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProviderOptionSelection,
  type SelectProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

export type ModelResolution =
  | { readonly ok: true; readonly selection: ModelSelection }
  | { readonly ok: false; readonly detail: string };

export interface ModelResolutionContext {
  readonly input: Pick<AgentThreadSpawnInput, "provider" | "model" | "reasoningEffort">;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Highest-priority default first: project default, then workspace default, then the caller's own selection. */
  readonly defaults: ReadonlyArray<ModelSelection | null | undefined>;
}

const EFFORT_OPTION_ID = /effort/i;

function pickDefaultModel(provider: ServerProvider): string | undefined {
  const flagged = provider.models.find((model) => model.isDefault)?.slug;
  if (flagged !== undefined) {
    return flagged;
  }
  // The driver-level default only counts when the live catalog carries it (or
  // the catalog is empty and there is nothing to check against).
  const driverDefault = DEFAULT_MODEL_BY_PROVIDER[provider.driver];
  const inCatalog = provider.models.some((model) => model.slug === driverDefault);
  if (driverDefault !== undefined && (inCatalog || provider.models.length === 0)) {
    return driverDefault;
  }
  return provider.models[0]?.slug;
}

function effortDescriptor(
  model: ServerProviderModel | undefined,
): SelectProviderOptionDescriptor | undefined {
  return model?.capabilities?.optionDescriptors?.find(
    (descriptor): descriptor is SelectProviderOptionDescriptor =>
      descriptor.type === "select" && EFFORT_OPTION_ID.test(descriptor.id),
  );
}

/**
 * Explicit input wins field by field; anything unset falls back to the first
 * default whose provider matches, so `{ provider: "codex" }` still gets a
 * sensible model while `{ model: "..." }` alone stays on the default provider.
 */
export function resolveSpawnModelSelection(context: ModelResolutionContext): ModelResolution {
  const defaults = context.defaults.filter((entry): entry is ModelSelection => entry != null);
  const instanceId = context.input.provider ?? defaults[0]?.instanceId;
  if (instanceId === undefined) {
    return { ok: false, detail: "No provider is configured; pass `provider` explicitly." };
  }
  const provider = context.providers.find((entry) => entry.instanceId === instanceId);
  if (provider === undefined) {
    const known = context.providers.map((entry) => entry.instanceId).join(", ");
    return {
      ok: false,
      detail: `Unknown provider '${instanceId}'. Configured providers: ${known}.`,
    };
  }
  if (!provider.enabled || !isProviderAvailable(provider)) {
    return { ok: false, detail: `Provider '${instanceId}' is not available on this server.` };
  }

  const matchingDefault = defaults.find((entry) => entry.instanceId === instanceId);
  const model = context.input.model ?? matchingDefault?.model ?? pickDefaultModel(provider);
  if (model === undefined) {
    return {
      ok: false,
      detail: `Provider '${instanceId}' has no models; pass \`model\` explicitly.`,
    };
  }
  const catalogEntry = provider.models.find((entry) => entry.slug === model);
  if (catalogEntry === undefined && provider.models.length > 0) {
    const known = provider.models.map((entry) => entry.slug).join(", ");
    return {
      ok: false,
      detail: `Unknown model '${model}' on '${instanceId}'. Available: ${known}.`,
    };
  }

  const inheritedOptions = matchingDefault?.model === model ? (matchingDefault.options ?? []) : [];
  const descriptor = effortDescriptor(catalogEntry);
  let options: ReadonlyArray<ProviderOptionSelection> = inheritedOptions;
  if (context.input.reasoningEffort !== undefined && descriptor !== undefined) {
    const effort = context.input.reasoningEffort;
    if (!descriptor.options.some((choice) => choice.id === effort)) {
      const known = descriptor.options.map((choice) => choice.id).join(", ");
      return {
        ok: false,
        detail: `Unknown reasoning effort '${effort}' for '${model}'. Available: ${known}.`,
      };
    }
    options = [
      ...inheritedOptions.filter((option) => option.id !== descriptor.id),
      { id: descriptor.id, value: effort },
    ];
  }
  return {
    ok: true,
    selection: { instanceId, model, ...(options.length > 0 ? { options } : {}) },
  };
}

/**
 * A turn is in flight from the moment its user message lands until the
 * session leaves `running`, so a trailing user message (or a streaming
 * assistant one) counts as busy even before the provider has acknowledged it.
 * That covers the gap after `thread_send` where the session still reads as
 * ready or stopped from the previous turn.
 */
export function deriveAgentThreadState(
  session: OrchestrationSession | null,
  lastMessage: OrchestrationMessage | undefined,
): AgentThreadState {
  switch (session?.status) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "failed";
    case "interrupted":
      return "idle";
    case "stopped":
      if (session.lastError !== null) {
        return "failed";
      }
      break;
    default:
      break;
  }
  if (lastMessage === undefined || lastMessage.role === "user" || lastMessage.streaming) {
    return "starting";
  }
  return "idle";
}

export const isSettledAgentThreadState = (state: AgentThreadState): boolean =>
  state === "idle" || state === "failed";

export function summarizeAgentThread(
  thread: OrchestrationThread | OrchestrationThreadShell,
  lastMessage: OrchestrationMessage | undefined,
): AgentThreadSummary {
  return {
    threadId: thread.id,
    title: thread.title,
    state: deriveAgentThreadState(thread.session, lastMessage),
    provider: thread.modelSelection.instanceId,
    model: thread.modelSelection.model,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    lastError: thread.session?.lastError ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

export function lastCompletedAssistantMessage(
  messages: ReadonlyArray<OrchestrationMessage>,
): OrchestrationMessage | undefined {
  return messages.findLast((message) => message.role === "assistant" && !message.streaming);
}

/** Sidebar title for a spawned thread: first non-empty prompt line, clipped. */
export function titleFromPrompt(prompt: string, maxLength = 80): string {
  const line = prompt
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  const base = line ?? "Sub-thread";
  return base.length > maxLength ? `${base.slice(0, maxLength - 1).trimEnd()}…` : base;
}
