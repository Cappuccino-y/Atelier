import { useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Streaming-safe markdown rendering.
 *
 * Feeding incomplete markdown to a parser breaks visibly: an unclosed `**`
 * renders as literal asterisks, an opened ``` fence swallows the rest of the
 * document. The standard fix (Vercel streamdown / stream-md / "close-open
 * markdown" heuristic) is to close obviously-unfinished structures FOR
 * RENDERING ONLY while the stream is live, and pass the text through
 * untouched once it completes.
 */

function closeOpenFences(text: string): string {
  // count ``` fences outside of inline code — odd count => an open fence
  const fenceMatches = text.match(/^```/gm);
  const fenceCount = fenceMatches ? fenceMatches.length : 0;
  if (fenceCount % 2 === 1) text += "\n```";
  return text;
}

function closeInlineMarkers(text: string): string {
  // per-line heuristics: close dangling ** and ` markers (odd counts).
  // Deliberately crude — only applied while streaming, discarded on completion.
  const lines = text.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const boldCount = (line.match(/\*\*/g) ?? []).length;
    if (boldCount % 2 === 1) lines[i] += "**";
    // backtick pairs (ignore fenced/triple)
    const tickCount = (line.match(/`/g) ?? []).length;
    if (tickCount % 2 === 1) lines[i] += "`";
  }
  return lines.join("\n");
}

/** Close unfinished markdown structures so a partial stream renders cleanly. */
export function closeOpenMarkdown(text: string): string {
  let t = closeOpenFences(text);
  t = closeInlineMarkers(t);
  return t;
}

/** Trailing text from the last completed paragraph onward — bounds re-parsing
 *  cost for very long streams (only the tail re-renders per frame).
 *  DEPRECATED: sliding windows cause visible top-line shrink/reflow (the
 *  tail-window reflow bug). Callers now pass the FULL accumulated text and
 *  pin the container to the bottom instead. Kept as identity for compat. */
function streamingWindow(text: string, _maxChars = 2400): string {
  return text;
}

type Props = {
  /** accumulated stream text so far */
  text: string;
  /** true while the stream is live (enables closing heuristics + cursor) */
  streaming?: boolean;
  className?: string;
  markdownComponents?: Record<string, (props: any) => ReactNode>;
};

/**
 * Renders streaming markdown with an incremental-friendly path: while live,
 * only the trailing window is re-parsed and unfinished markers are closed;
 * on completion the full text renders through the standard components.
 */
export function StreamingMarkdown({ text, streaming = false, className, markdownComponents }: Props) {
  const safe = useMemo(
    () => (streaming ? closeOpenMarkdown(streamingWindow(text)) : text),
    [text, streaming],
  );
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {safe}
      </ReactMarkdown>
      {streaming && (
        <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-indigo-400 align-text-bottom animate-pulse rounded-sm" />
      )}
    </div>
  );
}
