import { ImageIcon } from "lucide-react";
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { cn } from "../../lib/utils";

/**
 * Only an absolute web URL leaves this renderer. Relative URLs would resolve against the app's
 * own origin, and every other scheme — javascript:, file:, data: — is exactly what an inert
 * renderer exists to refuse.
 */
export function inertUrl(url: string | undefined): string | null {
  if (url === undefined) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * GitHub-authored markdown rendered inert: no raw HTML survives, no local-file affordances
 * exist, and no remote media is fetched — an image renders as a link to itself rather than as a
 * request to somebody else's server. The chat renderer is deliberately not used here: it takes
 * a `cwd` and turns paths into live local-file actions, which host-authored content must never
 * hold, and its images load.
 */
const INERT_COMPONENTS: Components = {
  a: ({ href, children }) => {
    const safe = inertUrl(href);
    // A link whose target was refused keeps its words and loses its teeth.
    if (safe === null) return <span>{children}</span>;
    return (
      <a
        className="text-primary underline underline-offset-2"
        href={safe}
        rel="noreferrer noopener"
        target="_blank"
      >
        {children}
      </a>
    );
  },
  // Never an <img>: rendering one is a request to whichever server the author named, before
  // anyone decided to look. The reference stays reachable as a plain link.
  img: ({ src, alt }) => {
    const safe = inertUrl(typeof src === "string" ? src : undefined);
    const label = alt !== undefined && alt.trim().length > 0 ? alt : "image";
    if (safe === null) return <span>{label}</span>;
    return (
      <a
        className="inline-flex items-center gap-1 rounded border border-border bg-muted/50 px-1.5 py-0.5 align-middle text-xs text-muted-foreground hover:text-foreground"
        href={safe}
        rel="noreferrer noopener"
        target="_blank"
      >
        <ImageIcon aria-hidden className="size-3" />
        {label}
      </a>
    );
  },
};

export const IssueMarkdown = memo(function IssueMarkdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 space-y-3 text-sm leading-relaxed break-words [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium [&_hr]:border-border [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:text-xs [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[[rehypeSanitize, defaultSchema]]}
        skipHtml
        urlTransform={(url) => inertUrl(url) ?? ""}
        components={INERT_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
