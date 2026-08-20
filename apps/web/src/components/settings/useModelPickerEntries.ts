import { useMemo } from "react";
import type { ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";

/**
 * What a default-model picker needs of the workspace: every provider instance's entries with
 * the user's instance settings applied, plus the custom-model options each instance carries.
 * Shared by the project and workspace "new threads" rows so both pickers read one derivation.
 */
export function useModelPickerEntries(
  settings: UnifiedSettings,
  serverProviders: ReadonlyArray<ServerProvider>,
) {
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, serverProviders),
    [serverProviders, settings],
  );
  return { instanceEntries, modelOptionsByInstance };
}
