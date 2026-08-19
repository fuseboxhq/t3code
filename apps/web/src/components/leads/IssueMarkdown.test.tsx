import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { IssueMarkdown, inertUrl } from "./IssueMarkdown";

const render = (text: string) => renderToStaticMarkup(<IssueMarkdown text={text} />);

describe("inertUrl", () => {
  it("keeps only absolute web URLs", () => {
    expect(inertUrl("https://github.com/x/y/issues/1")).toBe("https://github.com/x/y/issues/1");
    expect(inertUrl("http://example.test/a")).toBe("http://example.test/a");
    expect(inertUrl("javascript:alert(1)")).toBeNull();
    expect(inertUrl("file:///etc/passwd")).toBeNull();
    expect(inertUrl("data:text/html,<script>1</script>")).toBeNull();
    expect(inertUrl("/relative/path")).toBeNull();
    expect(inertUrl("vscode://open?path=/x")).toBeNull();
    expect(inertUrl(undefined)).toBeNull();
  });
});

describe("IssueMarkdown", () => {
  it("renders no <img> for a markdown image, only a link to it", () => {
    const html = render("Before ![screenshot](https://evil.test/tracker.png) after");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://evil.test/tracker.png"');
    expect(html).toContain("screenshot");
  });

  it("drops raw HTML entirely, script tags included", () => {
    const html = render('Hello <script>alert(1)</script> <img src="https://evil.test/x.png"> bye');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.test");
    expect(html).toContain("Hello");
    expect(html).toContain("bye");
  });

  it("defuses hostile link schemes while keeping the words", () => {
    const html = render("[click me](javascript:alert(1)) and [fine](https://example.test)");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click me");
    expect(html).toContain('href="https://example.test"');
    // The safe link opens away from the app, carrying no opener back to it.
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noreferrer");
  });

  it("keeps ordinary GitHub-flavored structure", () => {
    const html = render("# Title\n\n- [ ] task\n\n`code` and **bold**\n\n> quote");
    expect(html).toContain("<h1");
    expect(html).toContain("<code");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<strong");
  });

  it("renders local-file-looking paths as plain text with no affordance", () => {
    const html = render("See `apps/server/src/http.ts:42` for details");
    expect(html).not.toContain("<a");
    expect(html).toContain("apps/server/src/http.ts:42");
  });
});
