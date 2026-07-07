import { describe, it, expect } from "vitest";
import {
  parseFileViewMode,
  cycleMode,
  buildFolderTree,
  compactFolders,
  aggregateThreadCounts,
  findFirstFile,
  flattenHunks,
  findAdjacentHunk,
  type DiffFileItem,
  type FolderNode,
  type StaticTreeNode,
} from "./fileTree";
import { DiffStatus, type DiffHunk } from "./diffParser";

function file(
  path: string,
  openThreads = 0,
  hunks: DiffHunk[] = [],
): DiffFileItem {
  return {
    kind: "file",
    path,
    oldPath: path,
    newPath: path,
    status: DiffStatus.Modified,
    additions: 0,
    deletions: 0,
    hunks,
    openThreads,
  };
}

function hunk(firstChangedNewLine: number, index = 1): DiffHunk {
  return {
    index,
    oldStart: firstChangedNewLine,
    oldCount: 1,
    newStart: firstChangedNewLine,
    newCount: 1,
    section: "",
    additions: 1,
    deletions: 0,
    firstChangedNewLine,
    preview: "",
  };
}

describe("parseFileViewMode", () => {
  it("returns the value when valid", () => {
    expect(parseFileViewMode("flat")).toBe("flat");
    expect(parseFileViewMode("compact-tree")).toBe("compact-tree");
  });

  it("falls back to compact-tree for anything invalid", () => {
    expect(parseFileViewMode("tree")).toBe("compact-tree");
    expect(parseFileViewMode(undefined)).toBe("compact-tree");
    expect(parseFileViewMode(42)).toBe("compact-tree");
    expect(parseFileViewMode(null)).toBe("compact-tree");
  });
});

describe("cycleMode", () => {
  it("toggles between the two modes", () => {
    expect(cycleMode("flat")).toBe("compact-tree");
    expect(cycleMode("compact-tree")).toBe("flat");
  });
});

describe("buildFolderTree", () => {
  it("returns empty for no files", () => {
    expect(buildFolderTree([])).toEqual([]);
  });

  it("places a root-level file directly at the root", () => {
    const tree = buildFolderTree([file("README.md")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].kind).toBe("file");
  });

  it("nests files under folder nodes by path segment", () => {
    const tree = buildFolderTree([file("src/a.ts"), file("src/b.ts")]);
    expect(tree).toHaveLength(1);
    const folder = tree[0] as FolderNode;
    expect(folder.kind).toBe("folder");
    expect(folder.label).toBe("src");
    expect(folder.children).toHaveLength(2);
  });

  it("reuses a folder node for files sharing a path prefix", () => {
    const tree = buildFolderTree([file("src/x/a.ts"), file("src/y/b.ts")]);
    const src = tree[0] as FolderNode;
    expect(src.children.map((c) => (c as FolderNode).label).sort()).toEqual([
      "x",
      "y",
    ]);
  });

  it("sorts files by path so output is deterministic", () => {
    const tree = buildFolderTree([file("b.ts"), file("a.ts")]);
    expect((tree[0] as DiffFileItem).path).toBe("a.ts");
    expect((tree[1] as DiffFileItem).path).toBe("b.ts");
  });
});

describe("compactFolders", () => {
  it("merges a single-child folder chain into one labeled node", () => {
    const tree = buildFolderTree([file("src/deep/nested/a.ts")]);
    const compacted = compactFolders(tree);
    const folder = compacted[0] as FolderNode;
    expect(folder.label).toBe("src/deep/nested");
    expect(folder.children).toHaveLength(1);
    expect(folder.children[0].kind).toBe("file");
  });

  it("does not merge when a folder has multiple children", () => {
    const tree = buildFolderTree([file("src/a.ts"), file("src/b.ts")]);
    const folder = compactFolders(tree)[0] as FolderNode;
    expect(folder.label).toBe("src");
    expect(folder.children).toHaveLength(2);
  });

  it("compacts the chain but stops at the branch point", () => {
    const tree = buildFolderTree([file("a/b/c/x.ts"), file("a/b/d/y.ts")]);
    const top = compactFolders(tree)[0] as FolderNode;
    expect(top.label).toBe("a/b");
    expect(top.children).toHaveLength(2);
  });
});

describe("aggregateThreadCounts", () => {
  it("sums descendant file thread counts into folders", () => {
    const tree = buildFolderTree([
      file("src/a.ts", 2),
      file("src/sub/b.ts", 3),
    ]);
    aggregateThreadCounts(tree);
    const src = tree[0] as FolderNode;
    expect(src.openThreads).toBe(5);
    const sub = src.children.find((c) => c.kind === "folder") as FolderNode;
    expect(sub.openThreads).toBe(3);
  });

  it("leaves folders at zero when no threads exist", () => {
    const tree = buildFolderTree([file("src/a.ts")]);
    aggregateThreadCounts(tree);
    expect((tree[0] as FolderNode).openThreads).toBe(0);
  });
});

describe("findFirstFile", () => {
  it("returns undefined for an empty tree", () => {
    expect(findFirstFile([])).toBeUndefined();
  });

  it("returns the first file in DFS traversal order", () => {
    const tree = buildFolderTree([file("src/z/a.ts"), file("docs/b.ts")]);
    // sorted by path: docs/b.ts comes before src/z/a.ts
    expect(findFirstFile(tree)?.path).toBe("docs/b.ts");
  });

  it("descends through folders to find a nested file", () => {
    const nested: StaticTreeNode[] = [
      {
        kind: "folder",
        label: "deep",
        folderPath: "deep",
        openThreads: 0,
        children: [file("deep/only.ts")],
      },
    ];
    expect(findFirstFile(nested)?.path).toBe("deep/only.ts");
  });
});

describe("flattenHunks", () => {
  it("returns an empty array for no files", () => {
    expect(flattenHunks([])).toEqual([]);
  });

  it("skips files with zero hunks entirely", () => {
    const files = [file("a.ts", 0, []), file("b.ts", 0, [hunk(10)])];
    const flat = flattenHunks(files);
    expect(flat).toHaveLength(1);
    expect(flat[0].file.path).toBe("b.ts");
  });

  it("orders entries by file path, then by hunk order within a file", () => {
    const files = [
      file("z.ts", 0, [hunk(5, 1), hunk(20, 2)]),
      file("a.ts", 0, [hunk(1, 1)]),
    ];
    const flat = flattenHunks(files);
    expect(flat.map((f) => [f.file.path, f.hunk.firstChangedNewLine])).toEqual([
      ["a.ts", 1],
      ["z.ts", 5],
      ["z.ts", 20],
    ]);
  });
});

describe("findAdjacentHunk", () => {
  it("returns undefined when the stream is empty", () => {
    expect(findAdjacentHunk([], undefined, undefined, "next")).toBeUndefined();
  });

  it("returns the first entry for next with no current position", () => {
    const flat = flattenHunks([file("a.ts", 0, [hunk(5), hunk(20, 2)])]);
    expect(findAdjacentHunk(flat, undefined, undefined, "next")).toBe(flat[0]);
  });

  it("returns the last entry for prev with no current position", () => {
    const flat = flattenHunks([file("a.ts", 0, [hunk(5), hunk(20, 2)])]);
    expect(findAdjacentHunk(flat, undefined, undefined, "prev")).toBe(
      flat[flat.length - 1],
    );
  });

  it("moves to the nearest later hunk within the same file (next)", () => {
    const files = [file("a.ts", 0, [hunk(5, 1), hunk(20, 2), hunk(40, 3)])];
    const flat = flattenHunks(files);
    expect(findAdjacentHunk(flat, "a.ts", 5, "next")).toBe(flat[1]);
    expect(findAdjacentHunk(flat, "a.ts", 21, "next")).toBe(flat[2]);
  });

  it("moves to the nearest earlier hunk within the same file (prev)", () => {
    const files = [file("a.ts", 0, [hunk(5, 1), hunk(20, 2), hunk(40, 3)])];
    const flat = flattenHunks(files);
    expect(findAdjacentHunk(flat, "a.ts", 40, "prev")).toBe(flat[1]);
    expect(findAdjacentHunk(flat, "a.ts", 21, "prev")).toBe(flat[1]);
  });

  it("cursor exactly on a hunk's line moves strictly to the next/prev hunk, not itself", () => {
    const files = [file("a.ts", 0, [hunk(5, 1), hunk(20, 2)])];
    const flat = flattenHunks(files);
    expect(findAdjacentHunk(flat, "a.ts", 20, "next")).toBe(flat[0]); // wraps: no later hunk in file
    expect(findAdjacentHunk(flat, "a.ts", 5, "prev")).toBe(
      flat[flat.length - 1],
    ); // wraps: no earlier hunk in file
  });

  it("crosses a file boundary to the first hunk of the next file", () => {
    const files = [
      file("a.ts", 0, [hunk(5, 1), hunk(20, 2)]),
      file("b.ts", 0, [hunk(1, 1), hunk(9, 2)]),
    ];
    const flat = flattenHunks(files);
    // last hunk of a.ts, going next -> first hunk of b.ts
    expect(findAdjacentHunk(flat, "a.ts", 20, "next")).toEqual({
      file: files[1],
      hunk: files[1].hunks[0],
    });
  });

  it("crosses a file boundary to the last hunk of the previous file", () => {
    const files = [
      file("a.ts", 0, [hunk(5, 1), hunk(20, 2)]),
      file("b.ts", 0, [hunk(1, 1), hunk(9, 2)]),
    ];
    const flat = flattenHunks(files);
    // first hunk of b.ts, going prev -> last hunk of a.ts
    expect(findAdjacentHunk(flat, "b.ts", 1, "prev")).toEqual({
      file: files[0],
      hunk: files[0].hunks[1],
    });
  });

  it("wraps from the last hunk of the last file to the very first entry (next)", () => {
    const files = [
      file("a.ts", 0, [hunk(5, 1)]),
      file("b.ts", 0, [hunk(1, 1), hunk(9, 2)]),
    ];
    const flat = flattenHunks(files);
    expect(findAdjacentHunk(flat, "b.ts", 9, "next")).toBe(flat[0]);
  });

  it("wraps from the first hunk of the first file to the very last entry (prev)", () => {
    const files = [
      file("a.ts", 0, [hunk(5, 1)]),
      file("b.ts", 0, [hunk(1, 1), hunk(9, 2)]),
    ];
    const flat = flattenHunks(files);
    expect(findAdjacentHunk(flat, "a.ts", 5, "prev")).toBe(
      flat[flat.length - 1],
    );
  });

  it("handles the single-file single-hunk degenerate case by wrapping to itself", () => {
    const files = [file("a.ts", 0, [hunk(5)])];
    const flat = flattenHunks(files);
    expect(findAdjacentHunk(flat, "a.ts", 5, "next")).toBe(flat[0]);
    expect(findAdjacentHunk(flat, "a.ts", 5, "prev")).toBe(flat[0]);
  });

  it("skips files with zero hunks when crossing boundaries", () => {
    const files = [
      file("a.ts", 0, [hunk(5, 1)]),
      file("b.ts", 0, []), // no hunks — must be skipped entirely
      file("c.ts", 0, [hunk(1, 1)]),
    ];
    const flat = flattenHunks(files);
    expect(findAdjacentHunk(flat, "a.ts", 5, "next")).toEqual({
      file: files[2],
      hunk: files[2].hunks[0],
    });
  });

  it("falls back to the first/last entry when currentPath matches nothing in the stream", () => {
    const files = [file("a.ts", 0, [hunk(5, 1), hunk(20, 2)])];
    const flat = flattenHunks(files);
    expect(findAdjacentHunk(flat, "missing.ts", 5, "next")).toBe(flat[0]);
    expect(findAdjacentHunk(flat, "missing.ts", 5, "prev")).toBe(
      flat[flat.length - 1],
    );
  });
});
