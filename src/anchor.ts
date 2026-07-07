import type { ThreadAnchor } from "./sessionStore";

/**
 * Render a thread anchor as human-readable context for agent-facing output
 * (resolve prompts, AGENTS.md). One case per anchor type — keep the
 * `diff-line` branch's output byte-identical to what agentInvoker/skillGenerator
 * produced before this helper existed.
 */
export function describeAnchor(anchor: ThreadAnchor): string {
  if (anchor.type === "diff-line") {
    return `- **File**: \`${anchor.path}\` line ${anchor.line} (${anchor.side} side)
- **Preview**: \`${anchor.preview || "(no preview)"}\``;
  }

  const viewport = anchor.viewport
    ? `${anchor.viewport.width}x${anchor.viewport.height}`
    : undefined;

  return `- **URL**: \`${anchor.url}\`
- **Selector**: \`${anchor.selector}\`
- **Label**: ${anchor.label}${viewport ? `\n- **Viewport**: ${viewport}` : ""}`;
}
