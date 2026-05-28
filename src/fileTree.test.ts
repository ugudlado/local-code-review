import { describe, it, expect } from "vitest";
import {
  parseFileViewMode,
  cycleMode,
  buildFolderTree,
  compactFolders,
  aggregateThreadCounts,
  findFirstFile,
  type DiffFileItem,
  type FolderNode,
  type TreeNode,
} from "./fileTree";
import { DiffStatus } from "./diffParser";

function file(path: string, openThreads = 0): DiffFileItem {
  return {
    kind: "file",
    path,
    oldPath: path,
    newPath: path,
    status: DiffStatus.Modified,
    additions: 0,
    deletions: 0,
    openThreads,
  };
}

describe("parseFileViewMode", () => {
  it("returns the value when valid", () => {
    expect(parseFileViewMode("flat")).toBe("flat");
    expect(parseFileViewMode("compact-tree")).toBe("compact-tree");
  });

  it("falls back to flat for anything invalid", () => {
    expect(parseFileViewMode("tree")).toBe("flat");
    expect(parseFileViewMode(undefined)).toBe("flat");
    expect(parseFileViewMode(42)).toBe("flat");
    expect(parseFileViewMode(null)).toBe("flat");
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
    const nested: TreeNode[] = [
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
