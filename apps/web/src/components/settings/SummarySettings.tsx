import { useAtomValue } from "@effect/atom-react";
import type { SummaryAutoRefreshMode } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveSummaryModelSelection } from "@t3tools/shared/serverSettings";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { primaryServerProvidersAtom } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const AUTO_REFRESH_OPTIONS: Record<SummaryAutoRefreshMode, { label: string; description: string }> =
  {
    turn_end: {
      label: "After each turn",
      description: "Refreshes a thread's summary when the agent finishes a turn.",
    },
    live: {
      label: "After each turn and while running",
      description:
        "Refreshes when a turn finishes and every few minutes while a long turn is still running.",
    },
    off: {
      label: "Manual only",
      description: "Summaries only update when you ask for one from the thread or project menu.",
    },
  };

/** Model and refresh policy for thread and project summaries. */
export function SummarySettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const mode = settings.summaryAutoRefresh;
  const defaultMode = DEFAULT_UNIFIED_SETTINGS.summaryAutoRefresh;
  const selection = resolveSummaryModelSelection(settings, serverProviders);
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    selection.instanceId,
    selection.model,
  );

  return (
    <SettingsSection title="Summaries">
      <SettingsRow
        title="Automatic refresh"
        description={AUTO_REFRESH_OPTIONS[mode].description}
        resetAction={
          mode !== defaultMode ? (
            <SettingResetButton
              label="summary refresh"
              onClick={() => updateSettings({ summaryAutoRefresh: defaultMode })}
            />
          ) : null
        }
        control={
          <Select
            value={mode}
            onValueChange={(value) =>
              updateSettings({ summaryAutoRefresh: value as SummaryAutoRefreshMode })
            }
          >
            <SelectTrigger className="w-full sm:w-64" aria-label="Summary automatic refresh">
              <SelectValue>{AUTO_REFRESH_OPTIONS[mode].label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(AUTO_REFRESH_OPTIONS) as SummaryAutoRefreshMode[]).map((option) => (
                <SelectItem key={option} hideIndicator value={option}>
                  {AUTO_REFRESH_OPTIONS[option].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Summary model"
        description="Writes thread and project summaries. Each summary reads the whole thread, so a stronger model than the text generation default pays off."
        control={
          <ProviderModelPicker
            activeInstanceId={selection.instanceId}
            model={selection.model}
            lockedProvider={null}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptionsByInstance}
            triggerVariant="outline"
            triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
            triggerAriaLabel="Summary model"
            onInstanceModelChange={(instanceId, model) => {
              updateSettings({
                summaryModelSelection: createModelSelection(
                  instanceId,
                  model,
                  instanceId === selection.instanceId ? selection.options : undefined,
                ),
              });
            }}
          />
        }
      />
    </SettingsSection>
  );
}
