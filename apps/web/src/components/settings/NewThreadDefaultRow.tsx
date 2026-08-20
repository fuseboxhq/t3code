import type { ModelSelection, ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";

import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { useModelPickerEntries } from "./useModelPickerEntries";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

/**
 * The workspace-wide default a brand-new thread's composer starts from: one model and effort for
 * every project that has not set its own in project settings. Its own component because the row
 * owns picker state the surrounding providers panel has no other use for.
 */
export function NewThreadDefaultRow({
  settings,
  serverProviders,
  updateSettings,
}: {
  readonly settings: UnifiedSettings;
  readonly serverProviders: ReadonlyArray<ServerProvider>;
  readonly updateSettings: (patch: {
    readonly newThreadModelSelection: ModelSelection | null;
  }) => void;
}) {
  const selection = resolveDefaultProviderModelSelection(
    serverProviders,
    settings.newThreadModelSelection,
  );
  const { instanceEntries, modelOptionsByInstance } = useModelPickerEntries(
    settings,
    serverProviders,
  );
  const activeEntry = instanceEntries.find((entry) => entry.instanceId === selection?.instanceId);
  const setSelection = (next: ModelSelection | null) =>
    updateSettings({ newThreadModelSelection: next });

  return (
    <SettingsRow
      title="New threads"
      description="New threads anywhere in this workspace start with this model and its chosen traits. A project's own default model, set in its project settings, still wins for that project."
      resetAction={
        settings.newThreadModelSelection !== null ? (
          <SettingResetButton label="new thread model" onClick={() => setSelection(null)} />
        ) : null
      }
      control={
        selection && activeEntry ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              onInstanceModelChange={(instanceId, model) => {
                setSelection(createModelSelection(instanceId, model));
              }}
            />
            <TraitsPicker
              provider={activeEntry.driverKind as ProviderDriverKind}
              models={activeEntry.models}
              model={selection.model}
              prompt=""
              onPromptChange={() => {}}
              modelOptions={selection.options ?? []}
              allowPromptInjectedEffort={false}
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              onModelOptionsChange={(nextOptions) => {
                setSelection(
                  createModelSelection(selection.instanceId, selection.model, nextOptions),
                );
              }}
            />
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">No providers available</span>
        )
      }
    />
  );
}
