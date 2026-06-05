import type { DiffFileEntry } from "./diffParser";

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
  children: TreeNode[];
  openThreads: number;
}

export type TreeNode = FolderNode | DiffFileItem;

/** Build a folder tree from a flat file list. Files are sorted by path first. */
export function buildFolderTree(files: DiffFileItem[]): TreeNode[] {
  if (files.length === 0) return [];

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const folderMap = new Map<string, FolderNode>();
  const rootChildren: TreeNode[] = [];

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
export function compactFolders(nodes: TreeNode[]): TreeNode[] {
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
export function aggregateThreadCounts(nodes: TreeNode[]): void {
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
export function findFirstFile(nodes: TreeNode[]): DiffFileItem | undefined {
  for (const node of nodes) {
    if (node.kind === "file") return node;
    if (node.kind === "folder") {
      const found = findFirstFile(node.children);
      if (found) return found;
    }
  }
  return undefined;
}
