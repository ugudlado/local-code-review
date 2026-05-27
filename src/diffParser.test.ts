import { describe, expect, it } from "vitest";
import {
  applyLineStats,
  DiffStatus,
  parseDiffFileList,
  type DiffFileEntry,
} from "./diffParser";

describe("parseDiffFileList", () => {
  it("returns [] for empty input", () => {
    expect(parseDiffFileList("")).toEqual([]);
    expect(parseDiffFileList("   \n  ")).toEqual([]);
  });

  it("parses a modified file with insertions and deletions", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 1111111..2222222 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,3 @@",
      "-old line",
      "+new line",
      " context",
    ].join("\n");

    const [entry] = parseDiffFileList(diff);
    expect(entry).toMatchObject<Partial<DiffFileEntry>>({
      path: "src/foo.ts",
      oldPath: "src/foo.ts",
      newPath: "src/foo.ts",
      status: DiffStatus.Modified,
      additions: 1,
      deletions: 1,
    });
  });

  it("recognises new file mode as Added", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,1 @@",
      "+hello",
    ].join("\n");

    const [entry] = parseDiffFileList(diff);
    expect(entry.status).toBe(DiffStatus.Added);
    expect(entry.path).toBe("new.ts");
  });

  it("recognises deleted file mode and uses oldPath as display path", () => {
    const diff = [
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-bye",
    ].join("\n");

    const [entry] = parseDiffFileList(diff);
    expect(entry.status).toBe(DiffStatus.Deleted);
    expect(entry.path).toBe("gone.ts");
  });

  it("recognises renames", () => {
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
    ].join("\n");

    const [entry] = parseDiffFileList(diff);
    expect(entry.status).toBe(DiffStatus.Renamed);
    expect(entry.oldPath).toBe("old.ts");
    expect(entry.newPath).toBe("new.ts");
    expect(entry.path).toBe("new.ts");
  });

  it("ignores +++/--- header lines when counting additions/deletions", () => {
    const diff = [
      "diff --git a/foo.ts b/foo.ts",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,2 +1,3 @@",
      "+added",
      "+also added",
      " context",
      "-removed",
    ].join("\n");

    const [entry] = parseDiffFileList(diff);
    expect(entry.additions).toBe(2);
    expect(entry.deletions).toBe(1);
  });

  it("dedupes colliding paths and keeps the entry with real hunks", () => {
    // Simulates a synthetic untracked-file header layered atop a real diff for
    // the same path — the entry with more hunk content should win.
    const synthetic = [
      "diff --git a/foo.ts b/foo.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/foo.ts",
    ].join("\n");
    const real = [
      "diff --git a/foo.ts b/foo.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/foo.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
    ].join("\n");

    const entries = parseDiffFileList(`${synthetic}\n${real}`);
    expect(entries).toHaveLength(1);
    expect(entries[0].additions).toBe(2);
  });
});

describe("applyLineStats", () => {
  it("overwrites hunk-derived counts with numstat counts when available", () => {
    const entries: DiffFileEntry[] = [
      {
        path: "a.ts",
        oldPath: "a.ts",
        newPath: "a.ts",
        status: DiffStatus.Modified,
        additions: 1,
        deletions: 1,
      },
    ];
    applyLineStats(
      entries,
      new Map([["a.ts", { additions: 10, deletions: 20 }]]),
    );
    expect(entries[0].additions).toBe(10);
    expect(entries[0].deletions).toBe(20);
  });

  it("falls back to newPath then oldPath when display path doesn't match", () => {
    const entries: DiffFileEntry[] = [
      {
        path: "new.ts",
        oldPath: "old.ts",
        newPath: "new.ts",
        status: DiffStatus.Renamed,
        additions: 0,
        deletions: 0,
      },
    ];
    applyLineStats(
      entries,
      new Map([["old.ts", { additions: 5, deletions: 3 }]]),
    );
    expect(entries[0].additions).toBe(5);
    expect(entries[0].deletions).toBe(3);
  });

  it("leaves entries untouched when no stats key matches", () => {
    const entries: DiffFileEntry[] = [
      {
        path: "a.ts",
        oldPath: "a.ts",
        newPath: "a.ts",
        status: DiffStatus.Modified,
        additions: 7,
        deletions: 7,
      },
    ];
    applyLineStats(
      entries,
      new Map([["other.ts", { additions: 0, deletions: 0 }]]),
    );
    expect(entries[0].additions).toBe(7);
    expect(entries[0].deletions).toBe(7);
  });
});
