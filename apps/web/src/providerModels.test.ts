import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderModelCapabilities, repickedModelSelection } from "./providerModels";

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

  it("drops a string value held for a boolean descriptor", () => {
    const selection = repickedModelSelection({
      instanceId: CODEX,
      model: "gpt-5.6-sol",
      sticky: { [CODEX]: { options: [{ id: "fastMode", value: "true" }] } },
      entryModels: [
        {
          slug: "gpt-5.6-sol",
          name: "gpt-5.6-sol",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              { id: "fastMode", type: "boolean" as const, label: "Fast", currentValue: false },
            ],
          },
        },
      ],
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

const PROVIDER = ProviderDriverKind.make("claudeAgent");

function capabilities(id: string): ModelCapabilities {
  return {
    optionDescriptors: [{ id, label: id, type: "boolean" }],
  };
}

function model(input: {
  slug: string;
  capabilities: ModelCapabilities;
  aliases?: ReadonlyArray<string>;
  isCustom?: boolean;
}): ServerProviderModel {
  return {
    slug: input.slug,
    name: input.slug,
    ...(input.aliases ? { aliases: [...input.aliases] } : {}),
    isCustom: input.isCustom ?? false,
    capabilities: input.capabilities,
  };
}

describe("getProviderModelCapabilities", () => {
  it("resolves model-declared aliases", () => {
    const aliasCapabilities = capabilities("aliased-option");
    const models = [
      model({
        slug: "synthetic-model",
        aliases: ["Legacy-Synthetic-Model"],
        capabilities: aliasCapabilities,
      }),
    ];

    expect(getProviderModelCapabilities(models, "legacy-synthetic-model", PROVIDER)).toEqual(
      aliasCapabilities,
    );
  });

  it("prefers an exact custom slug over a built-in model alias", () => {
    const customCapabilities = capabilities("custom-option");
    const models = [
      model({
        slug: "synthetic-model",
        aliases: ["custom-model"],
        capabilities: capabilities("built-in-option"),
      }),
      model({ slug: "custom-model", capabilities: customCapabilities, isCustom: true }),
    ];

    expect(getProviderModelCapabilities(models, " custom-model ", PROVIDER)).toEqual(
      customCapabilities,
    );
  });

  it("returns empty capabilities for an unknown slug", () => {
    const models = [
      model({
        slug: "default-model",
        capabilities: capabilities("default-option"),
      }),
    ];

    expect(getProviderModelCapabilities(models, "unknown-model", PROVIDER)).toEqual({
      optionDescriptors: [],
    });
  });
});
