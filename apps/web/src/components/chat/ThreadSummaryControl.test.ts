import { describe, expect, it } from "vite-plus/test";

import { formatSummaryMarkdown } from "./ThreadSummaryControl";

describe("formatSummaryMarkdown", () => {
  it("bolds the fixed labels and separates them into paragraphs", () => {
    const text = "Goal: Ship it.\nDone: Tests pass.\nNow: Review.\nBlocked: Waiting on Kev.";
    expect(formatSummaryMarkdown(text)).toBe(
      "**Goal:** Ship it.\n\n**Done:** Tests pass.\n\n**Now:** Review.\n\n**Blocked:** Waiting on Kev.",
    );
  });

  it("leaves text without labels alone", () => {
    expect(formatSummaryMarkdown("Plain `old.ts` prose.")).toBe("Plain `old.ts` prose.");
  });
});
