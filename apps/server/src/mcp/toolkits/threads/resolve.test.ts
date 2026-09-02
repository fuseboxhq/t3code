import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationMessage,
  type ServerProvider,
} from "@t3tools/contracts";

import { deriveAgentThreadState, resolveSpawnModelSelection, titleFromPrompt } from "./resolve.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

function provider(
  overrides: Partial<ServerProvider> & Pick<ServerProvider, "instanceId" | "driver">,
): ServerProvider {
  return {
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    availability: "available",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const solModel = {
  slug: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  isCustom: false,
  isDefault: true,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select" as const,
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
    ],
  },
};

const providers = [
  provider({ instanceId: codex, driver: ProviderDriverKind.make("codex"), models: [solModel] }),
  provider({
    instanceId: claude,
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [{ slug: "claude-fable-5-1", name: "Fable", isCustom: false, capabilities: null }],
  }),
];

describe("resolveSpawnModelSelection", () => {
  it("falls back to the first default, inheriting its options", () => {
    const result = resolveSpawnModelSelection({
      input: {},
      providers,
      defaults: [
        null,
        {
          instanceId: codex,
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      ],
    });
    expect(result).toEqual({
      ok: true,
      selection: {
        instanceId: codex,
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
    });
  });

  it("uses the provider's default model when only the provider is given", () => {
    const result = resolveSpawnModelSelection({
      input: { provider: claude },
      providers,
      defaults: [{ instanceId: codex, model: "gpt-5.6-sol" }],
    });
    expect(result).toEqual({
      ok: true,
      selection: { instanceId: claude, model: "claude-fable-5-1" },
    });
  });

  it("overrides the inherited effort option", () => {
    const result = resolveSpawnModelSelection({
      input: { reasoningEffort: "high" },
      providers,
      defaults: [
        {
          instanceId: codex,
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      ],
    });
    expect(result).toEqual({
      ok: true,
      selection: {
        instanceId: codex,
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  });

  it("rejects unknown providers, models, and effort levels with the known choices", () => {
    const unknownProvider = resolveSpawnModelSelection({
      input: { provider: ProviderInstanceId.make("grok") },
      providers,
      defaults: [],
    });
    expect(unknownProvider).toMatchObject({
      ok: false,
      detail: expect.stringContaining("codex, claudeAgent"),
    });

    const unknownModel = resolveSpawnModelSelection({
      input: { provider: codex, model: "gpt-4" },
      providers,
      defaults: [],
    });
    expect(unknownModel).toMatchObject({
      ok: false,
      detail: expect.stringContaining("gpt-5.6-sol"),
    });

    const unknownEffort = resolveSpawnModelSelection({
      input: { provider: codex, reasoningEffort: "ultra" },
      providers,
      defaults: [],
    });
    expect(unknownEffort).toMatchObject({
      ok: false,
      detail: expect.stringContaining("medium, high"),
    });
  });

  it("refuses providers that are disabled or unavailable", () => {
    const result = resolveSpawnModelSelection({
      input: { provider: codex },
      providers: [
        provider({
          instanceId: codex,
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          availability: "unavailable",
        }),
      ],
      defaults: [],
    });
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining("not available") });
  });
});

describe("deriveAgentThreadState", () => {
  const message = (role: OrchestrationMessage["role"], streaming = false) =>
    ({ role, streaming }) as OrchestrationMessage;
  const session = (
    status: "running" | "ready" | "error" | "stopped",
    lastError: string | null = null,
  ) => ({ status, lastError }) as never;

  it("treats a pending user message as busy even before the session reports running", () => {
    expect(deriveAgentThreadState(null, message("user"))).toBe("starting");
    expect(deriveAgentThreadState(session("ready"), message("user"))).toBe("starting");
    expect(deriveAgentThreadState(session("stopped"), message("user"))).toBe("starting");
    expect(deriveAgentThreadState(session("ready"), message("assistant", true))).toBe("starting");
  });

  it("settles on the completed assistant message or the session error", () => {
    expect(deriveAgentThreadState(session("ready"), message("assistant"))).toBe("idle");
    expect(deriveAgentThreadState(session("running"), message("assistant"))).toBe("running");
    expect(deriveAgentThreadState(session("error"), message("assistant"))).toBe("failed");
    expect(deriveAgentThreadState(session("stopped", "spawn failed"), message("user"))).toBe(
      "failed",
    );
  });
});

describe("titleFromPrompt", () => {
  it("uses the first non-empty line, clipped", () => {
    expect(titleFromPrompt("\n\n  Fix the login bug  \nmore detail")).toBe("Fix the login bug");
    expect(titleFromPrompt("x".repeat(100), 10)).toBe("xxxxxxxxx…");
    expect(titleFromPrompt("   ")).toBe("Sub-thread");
  });
});
