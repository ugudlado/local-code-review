import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import { BranchDetector } from "./branchDetector";
import { SessionStore } from "./sessionStore";
import type { SessionThread } from "./sessionStore";
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

const execFileAsync = promisify(execFile);

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

  // Shared mutable holder so command handlers, lifecycle hooks, and the
  // branch-change subscriber all see the same current sessionId.
  const sessionTracker = { current: null as string | null };

  /** Resolve the target branch: workspace state override > config setting. */
  const resolveTargetBranch = (): string => {
    const override = context.workspaceState.get<string>("targetBranchOverride");
    return override ?? getDefaultTargetBranch();
  };

  // Sync diff tree when target-branch or diff-base settings change.
  // baseProvider.setBaseRef is driven by diffPanelManager.populate(), so we
  // re-init through that path instead of setting it directly here.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("resolvr.defaultTargetBranch")) {
        const newTarget = getDefaultTargetBranch();
        outputChannel.appendLine(
          `Target branch setting changed to "${newTarget}"`,
        );
        // Re-detect in case current branch now matches the new default
        void branchDetector.initialize();
      }
      if (e.affectsConfiguration("resolvr.diffBase")) {
        outputChannel.appendLine(
          `Diff base mode changed — refreshing diff tree`,
        );
        void diffPanelManager.refresh(sessionTracker.current ?? undefined);
      }
    }),
  );

  // Subscribe to file watcher events (replaces WS session-updated)
  context.subscriptions.push(
    sessionWatcher.onDidSessionChange((session) => {
      if (!sessionTracker.current) return;
      const threads = session.threads ?? [];
      outputChannel.appendLine(
        `Session file changed: reconciling ${threads.length} threads for ${sessionTracker.current}`,
      );
      commentManager.loadThreads(threads);
      const openCount = threads.filter(
        (t: SessionThread) => t.status === "open",
      ).length;
      statusBar.updateThreadCount(threads.length, openCount);
      diffPanelManager.updateThreadCounts(threads);
      threadsTree.updateThreads(threads);
    }),
  );

  // When a session is auto-created on first comment, hydrate it so the
  // file watcher starts and external edits (e.g. Claude resolving threads)
  // propagate live without requiring a window reload.
  context.subscriptions.push(
    commentManager.onDidCreateSession(async (sessionId) => {
      sessionTracker.current = sessionId;
      await hydrateSession(sessionId);
    }),
  );

  // Refresh threads tree after in-process status changes (resolve, wontfix, etc.)
  // File watcher is suppressed for self-writes, so we refresh manually here.
  context.subscriptions.push(
    commentManager.onDidUpdateThread(async (sessionId) => {
      const session = await sessionStore.getSession(sessionId);
      if (!session) return;
      const threads = session.threads ?? [];
      const openCount = threads.filter(
        (t: SessionThread) => t.status === "open",
      ).length;
      statusBar.updateThreadCount(threads.length, openCount);
      diffPanelManager.updateThreadCounts(threads);
      threadsTree.updateThreads(threads);
      // Reconcile inline editor comments — needed when the status change
      // originated from the threads tree view (no inline thread to mutate).
      commentManager.loadThreads(threads);
    }),
  );

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const isNoisyPath = (fsPath: string) =>
    !fsPath.startsWith(workspaceRoot) ||
    fsPath.includes(`${path.sep}node_modules${path.sep}`) ||
    fsPath.includes(`${path.sep}.review${path.sep}`);
  const debouncedRefreshDiffs = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      outputChannel.appendLine("File change detected — refreshing diff tree");
      void diffPanelManager.refresh(
        sessionTracker.current ?? undefined,
        resolveTargetBranch(),
      );
    }, 1000);
  };

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!isNoisyPath(doc.uri.fsPath)) debouncedRefreshDiffs();
    }),
    vscode.workspace.onDidCreateFiles((e) => {
      if (e.files.some((f) => !isNoisyPath(f.fsPath))) debouncedRefreshDiffs();
    }),
    vscode.workspace.onDidDeleteFiles((e) => {
      if (e.files.some((f) => !isNoisyPath(f.fsPath))) debouncedRefreshDiffs();
    }),
    vscode.workspace.onDidRenameFiles((e) => {
      if (e.files.some((f) => !isNoisyPath(f.newUri.fsPath)))
        debouncedRefreshDiffs();
    }),
    { dispose: () => refreshTimer && clearTimeout(refreshTimer) },
  );

  // Resolve workspace name from git repo root (handles worktrees).
  const resolveWorkspace = async () => {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "--git-common-dir"],
        { cwd: workspaceRoot },
      );
      const gitCommonDir = path.resolve(workspaceRoot, stdout.trim());
      const repoName = path.basename(path.dirname(gitCommonDir));
      sessionStore.setWorkspaceName(repoName);
      outputChannel.appendLine(`Workspace resolved: ${repoName}`);
    } catch {
      const fallback = path.basename(workspaceRoot);
      sessionStore.setWorkspaceName(fallback);
      outputChannel.appendLine(`Workspace fallback: ${fallback}`);
    }
  };

  /** Populate the Changed Files tree — no session file required. */
  const populateDiffs = async (sessionId?: string) => {
    const targetBranch = resolveTargetBranch();
    await diffPanelManager.populate(sessionId, targetBranch);
    // Show "ready" with 0 threads — branch is active, just no session yet
    statusBar.setReady(0);
    outputChannel.appendLine(
      `Diffs populated (target: ${targetBranch}, session: ${sessionId ?? "none"})`,
    );
  };

  /** Hydrate session-dependent features — only call when session file exists. */
  const hydrateSession = async (sessionId: string) => {
    try {
      const session = await sessionStore.getSession(sessionId);
      if (!session) return;

      // baseProvider's ref is set via diffPanelManager.populate() below,
      // which resolves it against the session's persisted target branch.

      const threads = session.threads ?? [];
      const openThreads = threads.filter(
        (t: SessionThread) => t.status === "open",
      ).length;
      commentManager.loadThreads(threads);
      statusBar.setReady(threads.length, openThreads);
      threadsTree.updateThreads(threads);
      outputChannel.appendLine(
        `Session loaded: ${threads.length} threads (${openThreads} open)`,
      );

      // Start watching the session file for external changes
      sessionWatcher.watch(sessionStore.getSessionFilePath(sessionId));

      // Refresh diff tree with session's target branch and overlay thread counts
      await diffPanelManager.populate(sessionId);
      diffPanelManager.updateThreadCounts(threads);

      // Generate agent skill files (.review/AGENTS.md, .review/CLAUDE.md)
      try {
        const skillContext = await skillGenerator.buildContext(
          sessionId,
          sessionStore.getSessionFilePath(sessionId),
          session,
        );
        await skillGenerator.generate(skillContext, session);
        outputChannel.appendLine(`Agent skill files generated in .review/`);
      } catch (skillErr) {
        outputChannel.appendLine(
          `Skill generation failed: ${skillErr instanceof Error ? skillErr.message : String(skillErr)}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outputChannel.appendLine(
        `Failed to load session for ${sessionId}: ${msg}`,
      );
      void vscode.window.showErrorMessage(
        `Resolvr: Failed to load review session — ${msg}`,
      );
    }
  };

  // Initialize feature detection
  const init = async () => {
    await resolveWorkspace();
    const sessionId = await branchDetector.initialize();
    sessionTracker.current = sessionId;

    if (!sessionId) {
      statusBar.setNoBranch();
      outputChannel.appendLine(
        "On default branch — populating working-tree diffs",
      );
      // Still populate diffs so working-tree changes are visible on main/master
      await populateDiffs();
      return;
    }

    outputChannel.appendLine(`Working branch detected: ${sessionId}`);

    // Always populate diffs — no session required
    await populateDiffs(sessionId);

    // Hydrate session-dependent features only if session file exists
    const existingSession = await sessionStore.getSession(sessionId);
    if (existingSession) {
      await hydrateSession(sessionId);
    }
  };

  // Listen for branch changes
  branchDetector.onDidChangeBranch(async (newSessionId) => {
    outputChannel.appendLine(
      `Branch changed — session: ${newSessionId ?? "none"}`,
    );
    sessionTracker.current = newSessionId;
    sessionWatcher.unwatch();

    if (!newSessionId) {
      commentManager.loadThreads([]);
      threadsTree.updateThreads([]);
      statusBar.setNoBranch();
      // On default branch — show working-tree diffs instead of closing the panel
      await populateDiffs();
      return;
    }

    // Always populate diffs — no session required
    await populateDiffs(newSessionId);

    // Hydrate session-dependent features only if session file exists
    const existingSession = await sessionStore.getSession(newSessionId);
    if (existingSession) {
      await hydrateSession(newSessionId);
    }
  });

  registerCommands({
    context,
    outputChannel,
    workspaceRoot,
    sessionStore,
    branchDetector,
    diffPanelManager,
    skillGenerator,
    sessionTracker,
    resolveTargetBranch,
    init,
    hydrateSession,
  });

  void init();
}

export function deactivate(): void {
  // Cleanup handled by disposables in context.subscriptions
}
