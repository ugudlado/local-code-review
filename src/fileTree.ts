import type { DiffFileEntry, DiffHunk } from "./diffParser";

// ---------------------------------------------------------------------------
// Pure file-tree model + builders. No `vscode` import — this is Logic layer,
// tested directly in vitest with no mocks. The UI (changedFilesTree.ts)
// imports these to render a TreeDataProvider.
// ---------------------------------------------------------------------------

export type FileViewMode = "flat" | "compact-tree";

const VALID_MODES: FileViewMode[] = ["flat", "compact-tree"];

export function parseFileViewMode(raw: unknown): FileViewMode {
  return typeof raw === "string" && VALID_MODES.includes(raw as FileViewMode)
    ? (raw as FileViewMode)
    : "compact-tree";
}

export function cycleMode(current: FileViewMode): FileViewMode {
  return current === "flat" ? "compact-tree" : "flat";
}

export interface DiffFileItem extends DiffFileEntry {
  kind: "file";
  openThreads: number;
}

export interface FolderNode {
  kind: "folder";
  label: string;
  folderPath: string;
  children: StaticTreeNode[];
  openThreads: number;
}

export interface HunkNode {
  kind: "hunk";
  file: DiffFileItem;
  hunk: DiffHunk;
}

export type TreeNode = FolderNode | DiffFileItem | HunkNode;

/**
 * The statically-built tree (folders + files), before hunk children are
 * materialized on demand. Hunk nodes are never part of this shape — they're
 * computed lazily by the UI layer's getChildren() per expanded file node.
 */
export type StaticTreeNode = FolderNode | DiffFileItem;

/** Build a folder tree from a flat file list. Files are sorted by path first. */
export function buildFolderTree(files: DiffFileItem[]): StaticTreeNode[] {
  if (files.length === 0) return [];

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const folderMap = new Map<string, FolderNode>();
  const rootChildren: StaticTreeNode[] = [];

  for (const file of sorted) {
    const segments = file.path.split("/");
    let parentChildren = rootChildren;

    for (let i = 0; i < segments.length - 1; i++) {
      const folderPath = segments.slice(0, i + 1).join("/");
      let folder = folderMap.get(folderPath);
      if (!folder) {
        folder = {
          kind: "folder",
          label: segments[i],
          folderPath,
          children: [],
          openThreads: 0,
        };
        folderMap.set(folderPath, folder);
        parentChildren.push(folder);
      }
      parentChildren = folder.children;
    }

    parentChildren.push(file);
  }

  return rootChildren;
}

/**
 * Compact single-child folder chains into one node with a joined label.
 * Bottom-up (post-order DFS) — O(n) where n = total nodes.
 * Mutates nodes in place; safe because it runs on freshly-built trees.
 */
export function compactFolders(nodes: StaticTreeNode[]): StaticTreeNode[] {
  return nodes.map((node) => {
    if (node.kind === "file") return node;

    // Recurse first
    node.children = compactFolders(node.children);

    // Merge single-child folder chains
    while (node.children.length === 1 && node.children[0].kind === "folder") {
      const child = node.children[0];
      node.label = node.label + "/" + child.label;
      node.folderPath = child.folderPath;
      node.children = child.children;
    }

    return node;
  });
}

/** Aggregate openThreads from descendant files up into folder nodes. */
export function aggregateThreadCounts(nodes: StaticTreeNode[]): void {
  for (const node of nodes) {
    if (node.kind === "folder") {
      aggregateThreadCounts(node.children);
      node.openThreads = node.children.reduce(
        (sum, child) => sum + (child.openThreads ?? 0),
        0,
      );
    }
  }
}

/** DFS to find the first file node in tree traversal order. */
export function findFirstFile(
  nodes: StaticTreeNode[],
): DiffFileItem | undefined {
  for (const node of nodes) {
    if (node.kind === "file") return node;
    if (node.kind === "folder") {
      const found = findFirstFile(node.children);
      if (found) return found;
    }
  }
  return undefined;
}

export interface FlatHunk {
  file: DiffFileItem;
  hunk: DiffHunk;
}

/** Flatten every file's hunks into one ordered stream, sorted by path (files with no hunks contribute nothing). */
export function flattenHunks(files: DiffFileItem[]): FlatHunk[] {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const flat: FlatHunk[] = [];
  for (const file of sorted) {
    for (const hunk of file.hunks) {
      flat.push({ file, hunk });
    }
  }
  return flat;
}

/**
 * Find the next/prev (file, hunk) entry in the flat stream relative to the current
 * position, wrapping at both ends. No current position → first (next) / last (prev).
 */
export function findAdjacentHunk(
  flat: FlatHunk[],
  currentPath: string | undefined,
  currentLine: number | undefined,
  direction: "next" | "prev",
): FlatHunk | undefined {
  if (flat.length === 0) return undefined;

  if (currentPath === undefined) {
    return direction === "next" ? flat[0] : flat[flat.length - 1];
  }

  const sameFileIndices: number[] = [];
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].file.path === currentPath) sameFileIndices.push(i);
  }

  if (sameFileIndices.length > 0 && currentLine !== undefined) {
    if (direction === "next") {
      for (const i of sameFileIndices) {
        if (flat[i].hunk.firstChangedNewLine > currentLine) return flat[i];
      }
    } else {
      for (let j = sameFileIndices.length - 1; j >= 0; j--) {
        const i = sameFileIndices[j];
        if (flat[i].hunk.firstChangedNewLine < currentLine) return flat[i];
      }
    }
  }

  // Crossed a file boundary (or no match/no line) — move to the adjacent file's edge hunk.
  if (sameFileIndices.length > 0) {
    if (direction === "next") {
      const lastIndex = sameFileIndices[sameFileIndices.length - 1];
      return flat[(lastIndex + 1) % flat.length];
    } else {
      const firstIndex = sameFileIndices[0];
      return flat[(firstIndex - 1 + flat.length) % flat.length];
    }
  }

  // currentPath doesn't match any entry in the stream.
  return direction === "next" ? flat[0] : flat[flat.length - 1];
}
