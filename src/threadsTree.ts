import * as vscode from "vscode";
import type { SessionThread } from "./sessionStore";
import { SCHEME_ANNOTATION } from "./baseContentProvider";

// ---------------------------------------------------------------------------
// Tree item types
// ---------------------------------------------------------------------------

type TreeNode = StatusGroup | ThreadItem;

interface StatusGroup {
  kind: "group";
  status: string;
  label: string;
  icon: string;
  color: string;
  threads: SessionThread[];
}

interface ThreadItem {
  kind: "thread";
  thread: SessionThread;
}

// ---------------------------------------------------------------------------
// Status group definitions
// ---------------------------------------------------------------------------

const STATUS_GROUPS: Array<{
  status: string;
  label: string;
  icon: string;
  color: string;
}> = [
  {
    status: "open",
    label: "Open",
    icon: "circle-filled",
    color: "list.warningForeground",
  },
  {
    status: "resolved",
    label: "Resolved",
    icon: "check",
    color: "testing.iconPassed",
  },
  {
    status: "wontfix",
    label: "Won't Fix",
    icon: "circle-slash",
    color: "disabledForeground",
  },
  {
    status: "outdated",
    label: "Outdated",
    icon: "history",
    color: "editorInfo.foreground",
  },
];

const UI_FEEDBACK_GROUP = {
  status: "__ui-feedback__",
  label: "UI Feedback",
  icon: "device-camera",
  color: "charts.purple",
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ThreadsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _threads: SessionThread[] = [];

  updateThreads(threads: SessionThread[]): void {
    this._threads = threads;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === "group") {
      const item = new vscode.TreeItem(
        `${element.label} (${element.threads.length})`,
        element.threads.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon(
        element.icon,
        new vscode.ThemeColor(element.color),
      );
      item.contextValue = "threadGroup";
      return item;
    }

    const t = element.thread;
    if (t.anchor.type === "dom-element") return this._getDomElementTreeItem(t);

    // Thread item — handle both anchor.path and flat filePath formats.
    const anchor = t.anchor;
    const raw = t as unknown as Record<string, unknown>;
    const filePath =
      anchor?.path ??
      (typeof raw.filePath === "string" ? raw.filePath : "") ??
      "";
    const fileName = filePath
      ? (filePath.split("/").pop() ?? filePath)
      : "unknown";
    const line = anchor?.line ?? (typeof raw.line === "number" ? raw.line : 0);
    const preview = t.messages[0]?.text.slice(0, 60).replace(/\n/g, " ") ?? "";

    const item = new vscode.TreeItem(
      `${fileName}:${line}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = preview;
    item.tooltip = `${filePath}:${line}\n${preview}`;
    item.iconPath = new vscode.ThemeIcon("comment");
    item.contextValue = t.status === "open" ? "thread-open" : "thread-closed";

    // Click opens the diff view and scrolls to the thread's line
    if (filePath) {
      item.command = {
        command: "resolvr.goToThread",
        title: "Go to Thread",
        arguments: [filePath, line],
      };
    }

    return item;
  }

  /**
   * dom-element threads have no file/line — show label + originating URL
   * (in the tooltip). Click opens the thread's conversation: same
   * CommentController widget diff-line threads use, rendered on a read-only
   * virtual doc. contextValue stays thread-open/thread-closed (unchanged)
   * so the existing resolve/wontfix/outdated/reopen menu items — which are
   * anchor-agnostic — keep matching.
   */
  private _getDomElementTreeItem(thread: SessionThread): vscode.TreeItem {
    const anchor = thread.anchor;
    if (anchor.type !== "dom-element")
      throw new Error("expected dom-element anchor");

    const preview =
      thread.messages[0]?.text.slice(0, 60).replace(/\n/g, " ") ?? "";

    const item = new vscode.TreeItem(
      anchor.label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = preview;
    item.tooltip = `${anchor.url}\n${anchor.selector}\n${preview}`;
    item.iconPath = new vscode.ThemeIcon("device-camera");
    item.contextValue =
      thread.status === "open" ? "thread-open" : "thread-closed";
    item.command = {
      command: "vscode.open",
      title: "Open Conversation",
      arguments: [vscode.Uri.parse(`${SCHEME_ANNOTATION}:/${thread.id}`)],
    };
    return item;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      // Root: return status groups + the UI Feedback group (hide empty groups)
      return [...this._buildGroups(), this._buildUiFeedbackGroup()].filter(
        (g) => g.threads.length > 0,
      );
    }

    if (element.kind === "group") {
      return element.threads.map((thread) => ({
        kind: "thread" as const,
        thread,
      }));
    }

    return [];
  }

  getParent(_element: TreeNode): TreeNode | undefined {
    return undefined;
  }

  private _buildGroups(): StatusGroup[] {
    // Normalize "approved" → "resolved"
    const normalize = (s: string) => (s === "approved" ? "resolved" : s);

    return STATUS_GROUPS.map((def) => ({
      kind: "group" as const,
      ...def,
      threads: this._threads.filter(
        (t) =>
          t.anchor.type !== "dom-element" && normalize(t.status) === def.status,
      ),
    }));
  }

  private _buildUiFeedbackGroup(): StatusGroup {
    return {
      kind: "group" as const,
      ...UI_FEEDBACK_GROUP,
      threads: this._threads.filter((t) => t.anchor.type === "dom-element"),
    };
  }
}
