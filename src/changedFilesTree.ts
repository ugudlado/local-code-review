import * as vscode from "vscode";
import { DiffStatus } from "./diffParser";
import type { DiffFileEntry } from "./diffParser";
import { makeReviewFileUri } from "./fileDecorationProvider";
import type { SessionThread } from "./sessionStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileViewMode = "flat" | "compact-tree";

const VALID_MODES: FileViewMode[] = ["flat", "compact-tree"];

export function parseFileViewMode(raw: unknown): FileViewMode {
  return typeof raw === "string" && VALID_MODES.includes(raw as FileViewMode)
    ? (raw as FileViewMode)
    : "flat";
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

// ---------------------------------------------------------------------------
// File icons & status colors (unchanged from original)
// ---------------------------------------------------------------------------

const EXT_ICON_MAP: Record<string, string> = {
  ts: "symbol-file",
  tsx: "symbol-file",
  js: "symbol-file",
  jsx: "symbol-file",
  json: "json",
  md: "markdown",
  css: "symbol-color",
  scss: "symbol-color",
  html: "code",
  svg: "symbol-misc",
  png: "file-media",
  jpg: "file-media",
  gif: "file-media",
  yaml: "list-tree",
  yml: "list-tree",
  sh: "terminal",
  bash: "terminal",
  lock: "lock",
};

function getFileIcon(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_ICON_MAP[ext] ?? "file";
}

const STATUS_COLORS: Record<DiffStatus, string> = {
  [DiffStatus.Added]: "gitDecoration.addedResourceForeground",
  [DiffStatus.Deleted]: "gitDecoration.deletedResourceForeground",
  [DiffStatus.Modified]: "gitDecoration.modifiedResourceForeground",
  [DiffStatus.Renamed]: "gitDecoration.renamedResourceForeground",
};

const STATUS_LABELS: Record<DiffStatus, string> = {
  [DiffStatus.Added]: "Added",
  [DiffStatus.Deleted]: "Deleted",
  [DiffStatus.Modified]: "Modified",
  [DiffStatus.Renamed]: "Renamed",
};

// ---------------------------------------------------------------------------
// Tree building helpers
// ---------------------------------------------------------------------------

/** Build a folder tree from a flat file list. Files are sorted by path first. */
function buildFolderTree(files: DiffFileItem[]): TreeNode[] {
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
 */
function compactFolders(nodes: TreeNode[]): TreeNode[] {
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
function aggregateThreadCounts(nodes: TreeNode[]): void {
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

/** Build a parent map for O(1) getParent() lookups. */
function buildParentMap(
  nodes: TreeNode[],
  parent: TreeNode | undefined,
  map: Map<TreeNode, TreeNode | undefined>,
): void {
  for (const node of nodes) {
    map.set(node, parent);
    if (node.kind === "folder") {
      buildParentMap(node.children, node, map);
    }
  }
}

/** DFS to find the first file node in tree traversal order. */
function findFirstFile(nodes: TreeNode[]): DiffFileItem | undefined {
  for (const node of nodes) {
    if (node.kind === "file") return node;
    if (node.kind === "folder") {
      const found = findFirstFile(node.children);
      if (found) return found;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// TreeDataProvider
// ---------------------------------------------------------------------------

export class ChangedFilesTreeProvider
  implements vscode.TreeDataProvider<TreeNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _mode: FileViewMode = "flat";
  private _files: DiffFileItem[] = [];
  private _rootChildren: TreeNode[] = [];
  private _parentMap = new Map<TreeNode, TreeNode | undefined>();

  get mode(): FileViewMode {
    return this._mode;
  }

  setMode(mode: FileViewMode): void {
    if (this._mode === mode) return;
    this._mode = mode;
    this._rebuild();
  }

  setFiles(files: DiffFileEntry[]): void {
    this._files = files.map((f) => ({
      ...f,
      kind: "file" as const,
      openThreads: 0,
    }));
    this._rebuild();
  }

  updateThreadCounts(threads: SessionThread[]): void {
    const counts = new Map<string, number>();
    for (const t of threads) {
      if (t.status !== "open") continue;
      const path = t.anchor?.path;
      if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    let changed = false;
    for (const file of this._files) {
      const count =
        (counts.get(file.path) ?? 0) +
        (file.oldPath !== file.path ? (counts.get(file.oldPath) ?? 0) : 0);
      if (file.openThreads !== count) {
        file.openThreads = count;
        changed = true;
      }
    }
    if (!changed) return;

    // Re-aggregate folder counts if in tree modes
    if (this._mode !== "flat") {
      aggregateThreadCounts(this._rootChildren);
    }
    this._onDidChangeTreeData.fire();
  }

  get fileCount(): number {
    return this._files.length;
  }

  getFirstFile(): DiffFileItem | undefined {
    if (this._mode === "flat") return this._files[0];
    return findFirstFile(this._rootChildren);
  }

  // -----------------------------------------------------------------------
  // TreeDataProvider interface
  // -----------------------------------------------------------------------

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === "folder") {
      return this._getFolderTreeItem(element);
    }
    return this._getFileTreeItem(element);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) return this._rootChildren;
    if (element.kind === "folder") return element.children;
    return [];
  }

  getParent(element: TreeNode): TreeNode | undefined {
    return this._parentMap.get(element);
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private _rebuild(): void {
    if (this._mode === "flat") {
      this._rootChildren = this._files;
    } else {
      this._rootChildren = compactFolders(buildFolderTree(this._files));
      aggregateThreadCounts(this._rootChildren);
    }

    this._parentMap.clear();
    buildParentMap(this._rootChildren, undefined, this._parentMap);
    this._onDidChangeTreeData.fire();
  }

  private _getFolderTreeItem(folder: FolderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      folder.label,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.iconPath = vscode.ThemeIcon.Folder;
    item.contextValue = "folder";

    if (folder.openThreads > 0) {
      item.description = `${folder.openThreads} comment${folder.openThreads > 1 ? "s" : ""}`;
    }

    item.tooltip = folder.folderPath;
    return item;
  }

  private _getFileTreeItem(element: DiffFileItem): vscode.TreeItem {
    const label = element.path.split("/").pop() ?? element.path;
    const item = new vscode.TreeItem(
      label,
      vscode.TreeItemCollapsibleState.None,
    );

    item.resourceUri = makeReviewFileUri(element.path);

    const parts: string[] = [];

    if (this._mode === "flat" && element.path.includes("/")) {
      parts.push(element.path.slice(0, element.path.lastIndexOf("/")));
    } else if (this._mode === "compact-tree") {
      // Full path avoids misreading compact folder labels (e.g. scripts/lib vs scripts/tests)
      parts.push(element.path);
    }

    if (element.additions + element.deletions > 0) {
      parts.push(`+${element.additions}/\u2212${element.deletions}`);
    }

    if (element.openThreads > 0) {
      const suffix = `${element.openThreads} comment${element.openThreads > 1 ? "s" : ""}`;
      parts.push(parts.length > 0 ? `\u00b7 ${suffix}` : suffix);
    }

    item.description = parts.length > 0 ? parts.join(" ") : undefined;

    item.iconPath = new vscode.ThemeIcon(
      getFileIcon(element.path),
      new vscode.ThemeColor(STATUS_COLORS[element.status]),
    );

    // Diff opens via DiffPanelManager tree selection handler (keeps editor in sync)

    const statusLabel = STATUS_LABELS[element.status];
    const tooltipLines = [`${statusLabel}: ${element.path}`];
    if (element.status === DiffStatus.Renamed) {
      tooltipLines.push(`${element.oldPath} → ${element.newPath}`);
    }
    if (element.additions + element.deletions > 0) {
      tooltipLines.push(
        `+${element.additions} additions, ${element.deletions} deletions`,
      );
    }
    if (element.openThreads > 0) {
      tooltipLines.push(
        `${element.openThreads} open comment${element.openThreads > 1 ? "s" : ""}`,
      );
    }
    item.tooltip = tooltipLines.join("\n");

    return item;
  }
}
