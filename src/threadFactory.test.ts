import { describe, expect, it } from "vitest";
import { buildThread, diffLineAnchor, hashLineContent } from "./threadFactory";

describe("hashLineContent", () => {
  it("returns the first 8 hex chars of SHA-256", () => {
    // echo -n "hello" | shasum -a 256 → 2cf24dba5fb0a30e...
    expect(hashLineContent("hello")).toBe("2cf24dba");
  });

  it("matches the hash shape in existing session files", () => {
    expect(hashLineContent("anything")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("diffLineAnchor", () => {
  it("builds a diff-line anchor with preview and hash from line content", () => {
    const anchor = diffLineAnchor({
      path: "src/foo.ts",
      line: 12,
      lineEnd: 14,
      side: "new",
      lineContent: "const x = 1;",
    });
    expect(anchor).toEqual({
      type: "diff-line",
      hash: hashLineContent("const x = 1;"),
      path: "src/foo.ts",
      preview: "const x = 1;",
      line: 12,
      lineEnd: 14,
      side: "new",
    });
  });

  it("truncates preview to 120 chars", () => {
    const anchor = diffLineAnchor({
      path: "a.ts",
      line: 1,
      side: "new",
      lineContent: "x".repeat(200),
    });
    if (anchor.type !== "diff-line") throw new Error("wrong anchor type");
    expect(anchor.preview).toHaveLength(120);
  });
});

describe("buildThread", () => {
  it("builds an open improvement thread with one human message", () => {
    const thread = buildThread({
      anchor: {
        type: "dom-element",
        url: "http://localhost:5173/",
        selector: ".btn",
        label: "button",
      },
      text: "too small",
      author: "Browser",
    });

    expect(thread.status).toBe("open");
    expect(thread.severity).toBe("improvement");
    expect(thread.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({
      authorType: "human",
      author: "Browser",
      text: "too small",
    });
    expect(thread.messages[0].createdAt).toBe(thread.lastUpdatedAt);
  });

  it("generates distinct thread and message ids", () => {
    const thread = buildThread({
      anchor: diffLineAnchor({
        path: "a.ts",
        line: 1,
        side: "new",
        lineContent: "x",
      }),
      text: "t",
      author: "CLI",
    });
    expect(thread.id).not.toBe(thread.messages[0].id);
  });
});
