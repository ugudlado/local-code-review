import * as vscode from "vscode";
import { BranchDetector } from "./branchDetector";
import { SessionStore } from "./sessionStore";
import { SkillGenerator } from "./skillGenerator";
import { StatusBar } from "./statusBar";
import { CommentManager } from "./commentManager";
import { SessionWatcher } from "./sessionWatcher";
import {
  BaseContentProvider,
  EmptyContentProvider,
  SCHEME_BASE,
  SCHEME_EMPTY,
} from "./baseContentProvider";
import { DiffPanelManager } from "./diffPanelManager";
import { ThreadsTreeProvider } from "./threadsTree";
import { getDefaultTargetBranch } from "./config";
import { registerCommands } from "./activation/commands";
import { createLifecycle } from "./activation/lifecycle";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Resolvr");
  outputChannel.appendLine("Resolvr extension activated");

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    outputChannel.appendLine("No workspace folder found — going dormant");
    return;
  }

  // CRITICAL: Register content providers BEFORE CommentManager.
  // CommentManager._buildNewThread calls openTextDocument on virtual URIs,
  // which requires the provider to already be registered.
  const baseProvider = new BaseContentProvider(
    workspaceRoot,
    getDefaultTargetBranch(),
  );
  const emptyProvider = new EmptyContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      SCHEME_BASE,
      baseProvider,
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      SCHEME_EMPTY,
      emptyProvider,
    ),
    baseProvider,
  );

  const statusBar = new StatusBar();
  const branchDetector = new BranchDetector(workspaceRoot);
  const sessionWatcher = new SessionWatcher(outputChannel);

  // Single source of truth for session file IO. Every write fires
  // onBeforeWrite so the file watcher can suppress its own echo.
  const sessionStore = new SessionStore({
    workspaceRoot,
    onBeforeWrite: () => sessionWatcher.suppressNextChange(),
  });

  const commentManager = new CommentManager(
    workspaceRoot,
    outputChannel,
    sessionStore,
  );

  const diffPanelManager = new DiffPanelManager(
    workspaceRoot,
    baseProvider,
    outputChannel,
    context,
    sessionStore,
  );

  const skillGenerator = new SkillGenerator(workspaceRoot);

  // Threads tree view — grouped by status (below Changed Files)
  const threadsTree = new ThreadsTreeProvider();
  const threadsTreeView = vscode.window.createTreeView("resolvr.threads", {
    treeDataProvider: threadsTree,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    statusBar,
    branchDetector,
    commentManager,
    sessionWatcher,
    diffPanelManager,
    threadsTreeView,
    outputChannel,
  );

  // Wire up comment creation/reply/resolve commands.
  // Use commentSessionId (always set when on any branch) so comments work
  // on default branches too — separate from sessionId, which gates status-bar
  // dormancy and remains null on default branches.
  commentManager.setupCommentHandlers(
    context,
    () => branchDetector.commentSessionId,
    outputChannel,
    () => branchDetector.branchName,
  );

  // Restore comment visibility from workspace state (default: visible).
  const initialVisible = context.workspaceState.get<boolean>(
    "commentsVisible",
    true,
  );
  commentManager.setVisible(initialVisible);
  statusBar.setCommentsVisible(initialVisible);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "resolvr.toggleCommentsVisible",
      async () => {
        const next = !commentManager.visible;
        commentManager.setVisible(next);
        statusBar.setCommentsVisible(next);
        await context.workspaceState.update("commentsVisible", next);
        outputChannel.appendLine(`Comments ${next ? "shown" : "hidden"}`);
      },
    ),
  );

  const lifecycle = createLifecycle({
    context,
    outputChannel,
    workspaceRoot,
    sessionStore,
    branchDetector,
    commentManager,
    diffPanelManager,
    sessionWatcher,
    skillGenerator,
    statusBar,
    threadsTree,
  });

  lifecycle.subscribe();

  registerCommands({
    context,
    outputChannel,
    workspaceRoot,
    sessionStore,
    branchDetector,
    diffPanelManager,
    skillGenerator,
    resolveTargetBranch: lifecycle.resolveTargetBranch,
    init: lifecycle.init,
    hydrateSession: lifecycle.hydrateSession,
  });

  void lifecycle.init();
}

export function deactivate(): void {
  // Cleanup handled by disposables in context.subscriptions
}
