import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ModelCapabilities,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, resolveSelectableModel } from "@t3tools/shared/model";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

export function formatProviderDriverKindLabel(provider: ProviderDriverKind): string {
  return provider
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  return getProviderSnapshot(providers, provider)?.models ?? [];
}

function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ServerProvider | undefined {
  const defaultInstanceId = defaultInstanceIdForDriver(provider);
  return providers.find((candidate) => candidate.instanceId === defaultInstanceId);
}

// Resolve an instance selection to the correlated live driver. If the
// instance is absent, fall back to a live enabled provider instead of
// inferring a driver from the missing instance id.
export function resolveSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind | ProviderInstanceId | null | undefined,
): ProviderDriverKind {
  const requestedEntry = providers.find((candidate) => candidate.instanceId === provider);
  if (requestedEntry?.enabled) {
    return requestedEntry.driver;
  }
  return providers.find((candidate) => candidate.enabled)?.driver ?? DEFAULT_DRIVER_KIND;
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderDriverKind,
  planModeEnabled = true,
): ModelCapabilities {
  const slug = resolveSelectableModel(provider, model, models);
  const selectedModel = models.find((candidate) => candidate.slug === slug);
  const caps = selectedModel?.capabilities ?? EMPTY_CAPABILITIES;
  if (planModeEnabled) {
    return caps;
  }
  return withoutPlanAgentOption(caps);
}

// The opencode "plan" agent is only reachable while legacy plan mode is on.
// With it off, drop the option so it cannot be selected or dispatched, and
// drop the descriptor entirely when nothing remains selectable. currentValue
// is re-resolved against the surviving options so a stale or defaulted "plan"
// value cannot leak back into dispatch.
function withoutPlanAgentOption(caps: ModelCapabilities): ModelCapabilities {
  return {
    ...caps,
    optionDescriptors: (caps.optionDescriptors ?? []).flatMap((descriptor) => {
      if (descriptor.type !== "select" || descriptor.id !== "agent") {
        return [descriptor];
      }
      const options = descriptor.options.filter((option) => option.id !== "plan");
      if (options.length === 0) {
        return [];
      }
      const currentValue =
        descriptor.currentValue && options.some((option) => option.id === descriptor.currentValue)
          ? descriptor.currentValue
          : (options.find((option) => option.isDefault)?.id ?? options[0]?.id);
      return [{ ...descriptor, options, ...(currentValue ? { currentValue } : {}) }];
    }),
  };
}

export function getDefaultServerModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  const models = getProviderModels(providers, provider);
  return (
    models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    models.find((model) => !model.isCustom)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider] ??
    DEFAULT_MODEL
  );
}

/**
 * The options a re-picked model still understands, out of the ones the reader had chosen.
 * A select value the new model's descriptor does not list is dropped with its option, so a
 * carried effort can never name a level the model cannot run at.
 */
function carryModelOptions(
  heldOptions: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ProviderOptionSelection> {
  return heldOptions.filter((option) => {
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    if (descriptor === undefined) return false;
    return descriptor.type === "select"
      ? typeof option.value === "string" &&
          descriptor.options.some((choice) => choice.id === option.value)
      : typeof option.value === "boolean";
  });
}

/**
 * The selection a composer model re-pick lands on: the new model, keeping whichever of the
 * reader's held options it still understands. Built here so the pick handler stays a guard
 * sequence and the carrying rule stays testable on its own.
 */
export function repickedModelSelection(input: {
  instanceId: ProviderInstanceId;
  model: string;
  sticky: Partial<Record<ProviderInstanceId, { options?: ReadonlyArray<ProviderOptionSelection> }>>;
  entryModels: ReadonlyArray<ServerProviderModel> | undefined;
  driverKind: ProviderDriverKind | null;
}): {
  instanceId: ProviderInstanceId;
  model: string;
  options?: ReadonlyArray<ProviderOptionSelection>;
} {
  const descriptors =
    input.driverKind === null
      ? []
      : (getProviderModelCapabilities(input.entryModels ?? [], input.model, input.driverKind)
          .optionDescriptors ?? []);
  const carried = carryModelOptions(input.sticky[input.instanceId]?.options ?? [], descriptors);
  return {
    instanceId: input.instanceId,
    model: input.model,
    ...(carried.length > 0 ? { options: carried } : {}),
  };
}
