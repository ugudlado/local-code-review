import * as vscode from "vscode";
import * as path from "path";
import { BranchDetector } from "./branchDetector";
import { SessionStore } from "./sessionStore";
import { SkillGenerator } from "./skillGenerator";
import { StatusBar } from "./statusBar";
import { CommentManager } from "./commentManager";
import { SessionWatcher } from "./sessionWatcher";
import {
  BaseContentProvider,
  EmptyContentProvider,
  AnnotationContentProvider,
  SCHEME_BASE,
  SCHEME_EMPTY,
  SCHEME_ANNOTATION,
} from "./baseContentProvider";
import { DiffPanelManager } from "./diffPanelManager";
import { ThreadsTreeProvider } from "./threadsTree";
import { getDefaultTargetBranch, getCapturePort } from "./config";
import { registerCommands } from "./activation/commands";
import { createLifecycle } from "./activation/lifecycle";
import { startCaptureServer } from "./captureServer";

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
  const annotationProvider = new AnnotationContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      SCHEME_BASE,
      baseProvider,
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      SCHEME_EMPTY,
      emptyProvider,
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      SCHEME_ANNOTATION,
      annotationProvider,
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
    annotationProvider,
  );

  const diffPanelManager = new DiffPanelManager(
    workspaceRoot,
    baseProvider,
    outputChannel,
    context,
    sessionStore,
  );

  const skillGenerator = new SkillGenerator(
    workspaceRoot,
    getDefaultTargetBranch,
  );

  // Threads tree view — grouped by status (below Changed Files)
  const threadsTree = new ThreadsTreeProvider();
  const threadsTreeView = vscode.window.createTreeView("resolvr.threads", {
    treeDataProvider: threadsTree,
    showCollapseAll: true,
  });
  threadsTree.attachView(threadsTreeView);

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
  // Build lifecycle first so we can pass its resolveTargetBranch into the
  // comment handlers. CommentManager needs it to set the right target on
  // auto-created sessions.
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

  commentManager.setupCommentHandlers(
    context,
    () => branchDetector.commentSessionId,
    () => branchDetector.branchName,
    lifecycle.resolveTargetBranch,
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

  lifecycle.subscribe();

  // Browser annotation capture endpoint. Uses its own SessionStore instance
  // (no onBeforeWrite) so its writes are NOT suppressed by sessionWatcher —
  // unlike VS Code-originated writes, there is no in-process loadThreads()
  // call after a capture-server write, so the file watcher must be the one
  // to pick it up and refresh the Threads view.
  const captureSessionStore = new SessionStore({ workspaceRoot });
  let captureServer: import("http").Server | undefined;
  void startCaptureServer({
    port: getCapturePort(),
    getSessionId: () => branchDetector.commentSessionId,
    ensureSessionDefaults: () => ({
      worktreePath: workspaceRoot,
      sourceBranch:
        branchDetector.branchName ??
        branchDetector.commentSessionId ??
        "unknown",
      targetBranch: lifecycle.resolveTargetBranch(),
    }),
    sessionStore: captureSessionStore,
    // launchBranch intentionally omitted: unlike CLI/Vite, the extension
    // doesn't launch the user's app, so it can't know which branch the
    // running UI was built from — the drift warning can't apply here.
    getContext: () => ({
      workspaceName: path.basename(workspaceRoot),
      workspaceRoot,
      branch: branchDetector.branchName,
      sessionId: branchDetector.commentSessionId,
    }),
    annotateScriptPath: context.asAbsolutePath(
      path.join("assets", "annotate.js"),
    ),
    log: (msg) => outputChannel.appendLine(msg),
  }).then((server) => {
    captureServer = server;
  });
  context.subscriptions.push({
    dispose: () => captureServer?.close(),
  });

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
