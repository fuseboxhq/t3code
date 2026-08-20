import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { repickedModelSelection } from "./providerModels";

const CODEX = ProviderInstanceId.make("codex");
const codexDriver = ProviderDriverKind.make("codex");

const modelWithEfforts = (slug: string, efforts: ReadonlyArray<string>) => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        type: "select" as const,
        label: "Effort",
        options: efforts.map((id) => ({ id, label: id, isDefault: id === efforts[0] })),
      },
    ],
  },
});

describe("repickedModelSelection", () => {
  it("carries a sticky effort the new model still understands", () => {
    const selection = repickedModelSelection({
      instanceId: CODEX,
      model: "gpt-5.6-sol",
      sticky: { [CODEX]: { options: [{ id: "reasoningEffort", value: "high" }] } },
      entryModels: [modelWithEfforts("gpt-5.6-sol", ["low", "medium", "high"])],
      driverKind: codexDriver,
    });
    expect(selection.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
  });

  it("drops a sticky value the new model cannot run at", () => {
    const selection = repickedModelSelection({
      instanceId: CODEX,
      model: "gpt-5.6-sol",
      sticky: { [CODEX]: { options: [{ id: "reasoningEffort", value: "ultra" }] } },
      entryModels: [modelWithEfforts("gpt-5.6-sol", ["low", "medium", "high"])],
      driverKind: codexDriver,
    });
    expect(selection.options).toBeUndefined();
  });

  it("drops options the new model has no descriptor for", () => {
    const selection = repickedModelSelection({
      instanceId: CODEX,
      model: "gpt-5.6-sol",
      sticky: { [CODEX]: { options: [{ id: "collaborationMode", value: "solo" }] } },
      entryModels: [modelWithEfforts("gpt-5.6-sol", ["low", "high"])],
      driverKind: codexDriver,
    });
    expect(selection.options).toBeUndefined();
  });
});
