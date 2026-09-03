import { describe, expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { PreviewSnapshotToolkit, PreviewStandardToolkit } from "./preview/tools.ts";
import { ThreadToolkit } from "./threads/tools.ts";

const toolkits = { PreviewStandardToolkit, PreviewSnapshotToolkit, ThreadToolkit };

describe("agent MCP toolkits", () => {
  // MCP clients validate every tool's input schema as `{ type: "object", ... }`.
  // One tool that encodes to anything else (an empty struct becomes a bare
  // `anyOf`) makes the Claude client reject the whole tools/list response, so
  // the agent silently loses every T3 Code tool.
  it.each(Object.entries(toolkits))("%s advertises object input schemas", (_, toolkit) => {
    for (const tool of Object.values(toolkit.tools)) {
      const schema = Tool.getJsonSchema(tool) as { readonly type?: unknown };
      expect(schema.type, tool.name).toBe("object");
    }
  });
});
