import { createHash, randomUUID } from "crypto";
import type { SessionThread, ThreadAnchor } from "./sessionStore";

// ---------------------------------------------------------------------------
// Single source of truth for thread construction. Three writers share it
// (VS Code commentManager, browser captureServer, CLI) — ids, timestamps,
// and defaults must not drift apart. Logic layer: no `vscode`, no `fs`.
// ---------------------------------------------------------------------------

/** First 8 hex chars of SHA-256 of the line content — the anchor re-location key. */
export function hashLineContent(lineContent: string): string {
  return createHash("sha256").update(lineContent).digest("hex").slice(0, 8);
}

/** Build a diff-line anchor from a file position and the line's current content. */
export function diffLineAnchor(opts: {
  path: string;
  line: number;
  lineEnd?: number;
  side: "old" | "new";
  lineContent: string;
}): ThreadAnchor {
  return {
    type: "diff-line",
    hash: hashLineContent(opts.lineContent),
    path: opts.path,
    preview: opts.lineContent.slice(0, 120),
    line: opts.line,
    lineEnd: opts.lineEnd,
    side: opts.side,
  };
}

/** Build a new open thread with a single human message. */
export function buildThread(opts: {
  anchor: ThreadAnchor;
  text: string;
  author: string;
}): SessionThread {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    anchor: opts.anchor,
    status: "open",
    severity: "improvement",
    messages: [
      {
        id: randomUUID(),
        authorType: "human",
        author: opts.author,
        text: opts.text,
        createdAt: now,
      },
    ],
    lastUpdatedAt: now,
  };
}
