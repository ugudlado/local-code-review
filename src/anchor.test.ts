import { describe, expect, it } from "vitest";
import { describeAnchor } from "./anchor";
import type { ThreadAnchor } from "./sessionStore";

describe("describeAnchor", () => {
  it("renders a diff-line anchor with file, line, side, and preview", () => {
    const anchor: ThreadAnchor = {
      type: "diff-line",
      hash: "abc123",
      path: "src/foo.ts",
      preview: "const x = 1;",
      line: 42,
      side: "new",
    };

    expect(describeAnchor(anchor)).toBe(
      "- **File**: `src/foo.ts` line 42 (new side)\n" +
        "- **Preview**: `const x = 1;`",
    );
  });

  it("renders a diff-line anchor with no preview as (no preview)", () => {
    const anchor: ThreadAnchor = {
      type: "diff-line",
      hash: "abc123",
      path: "src/foo.ts",
      preview: "",
      line: 1,
      side: "old",
    };

    expect(describeAnchor(anchor)).toBe(
      "- **File**: `src/foo.ts` line 1 (old side)\n" +
        "- **Preview**: `(no preview)`",
    );
  });

  it("renders a dom-element anchor with url, selector, and label", () => {
    const anchor: ThreadAnchor = {
      type: "dom-element",
      url: "http://localhost:5173/settings",
      selector: "button.settings-toggle",
      label: "button 'Settings'",
    };

    expect(describeAnchor(anchor)).toBe(
      "- **URL**: `http://localhost:5173/settings`\n" +
        "- **Selector**: `button.settings-toggle`\n" +
        "- **Label**: button 'Settings'",
    );
  });

  it("renders a dom-element anchor's viewport when present", () => {
    const anchor: ThreadAnchor = {
      type: "dom-element",
      url: "http://localhost:5173/settings",
      selector: "button.settings-toggle",
      label: "button 'Settings'",
      viewport: { width: 375, height: 812 },
    };

    expect(describeAnchor(anchor)).toBe(
      "- **URL**: `http://localhost:5173/settings`\n" +
        "- **Selector**: `button.settings-toggle`\n" +
        "- **Label**: button 'Settings'\n" +
        "- **Viewport**: 375x812",
    );
  });
});
