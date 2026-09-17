import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Settings from "../serverSettings.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { evaluate as evaluateTool } from "../mcp/toolkits/jev/handlers.ts";
import { McpServer, McpSchema } from "effect/unstable/ai";
import { JevToolkitRegistrationLive } from "../mcp/McpHttpServer.ts";
import { JevEvaluationInput } from "@t3tools/contracts";
import { Jev, layer } from "./Jev.ts";

const input = {
  state: { document: "Tests passed." },
  questions: { passed: { type: "noul" as const, instructions: "Did the tests pass?" } },
};
const validResponse = {
  model: "jev-latest",
  answers: { passed: { type: "noul" as const, noul: 0.99 } },
  usage: { input_tokens: 12, output_tokens: 3 },
};

const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      ...JevEvaluationInput.fields,
      model: Schema.String,
    }),
  ),
);

function setup(status = 200, response: unknown = validResponse, enabled = true) {
  const requests: Array<{ url: string; key: string | undefined; body: string }> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({
          url: request.url,
          key: request.headers.authorization,
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        return HttpClientResponse.fromWeb(request, Response.json(response, { status }));
      }),
    ),
  );
  return {
    requests,
    layer: layer.pipe(
      Layer.provide(http),
      Layer.provideMerge(Settings.layerTest({ jev: { enabled, apiKey: "test-secret" } })),
    ),
  };
}

describe("Jev evaluation", () => {
  it.effect("sends typed questions with the server key and returns answers and usage", () => {
    const test = setup();
    return Effect.gen(function* () {
      const result = yield* (yield* Jev).evaluate(input);
      assert.deepEqual(result, validResponse);
      assert.equal(test.requests.length, 1);
      assert.equal(test.requests[0]?.url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(test.requests[0]?.key, "Bearer test-secret");
      const sent = yield* decodeRequest(test.requests[0]?.body);
      assert.deepEqual(sent, { ...input, model: "jev-latest" });
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("blocks existing callers immediately after disabling or removing the key", () => {
    const test = setup();
    return Effect.gen(function* () {
      const jev = yield* Jev;
      const settings = yield* Settings.ServerSettingsService;
      yield* jev.evaluate(input);
      yield* settings.updateSettings({ jev: { enabled: false } });
      assert.include((yield* Effect.flip(jev.evaluate(input))).message, "disabled");
      yield* settings.updateSettings({ jev: { enabled: true, apiKey: "" } });
      assert.include((yield* Effect.flip(jev.evaluate(input))).message, "API key");
      assert.equal(test.requests.length, 1);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("rejects oversized state before sending it to TypeSafe", () => {
    const test = setup();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        (yield* Jev).evaluate({ ...input, state: "x".repeat(128 * 1024) }),
      );
      assert.include(error.message, "128 KiB");
      assert.equal(test.requests.length, 0);
    }).pipe(Effect.provide(test.layer));
  });

  for (const [status, expected] of [
    [401, "API key"],
    [429, "rate limited"],
    [422, "questions"],
    [503, "could not complete"],
  ] as const) {
    it.effect(
      `reports HTTP ${status} without exposing upstream content or retrying a paid call`,
      () => {
        const test = setup(status, { error: "test-secret private-context" });
        return Effect.gen(function* () {
          const error = yield* Effect.flip((yield* Jev).evaluate(input));
          assert.include(error.message, expected);
          assert.notInclude(error.message, "test-secret");
          assert.notInclude(error.message, "private-context");
          assert.equal(test.requests.length, 1);
        }).pipe(Effect.provide(test.layer));
      },
    );
  }

  it.effect("rejects missing or invalid answers", () => {
    const test = setup(200, { ...validResponse, answers: {} });
    return Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Jev).evaluate(input));
      assert.include(error.message, "do not match");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("denies MCP credentials that were not granted Jev access", () => {
    const test = setup();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(evaluateTool(input));
      assert.include(error.message, "unavailable in this session");
      assert.equal(test.requests.length, 0);
    }).pipe(
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("test"),
        threadId: ThreadId.make("test"),
        providerSessionId: "test",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["threads"] as const),
        issuedAt: 1,
      }),
      Effect.provide(test.layer),
    );
  });
  it.effect("serves evaluations through the registered MCP tool", () => {
    const test = setup();
    const registered = JevToolkitRegistrationLive.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(test.layer),
    );
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server.callTool({ name: "typesafe_evaluate", arguments: input });
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.structuredContent, validResponse);
      assert.equal(test.requests.length, 1);
    }).pipe(
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("test"),
        threadId: ThreadId.make("test"),
        providerSessionId: "test",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["jev"] as const),
        issuedAt: 1,
      }),
      Effect.provideService(
        McpSchema.McpServerClient,
        McpSchema.McpServerClient.of({
          clientId: 1,
          protocolVersion: "2025-06-18",
          initializePayload: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "jev-test", version: "1" },
          },
          getClient: Effect.die("unused"),
        }),
      ),
      Effect.provide(registered),
    );
  });
});
