import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import { BranchDetector } from "./branchDetector";
import { SessionStore } from "./sessionStore";
import type { SessionThread } from "./sessionStore";
import { SkillGenerator } from "./skillGenerator";
import { resolveInExistingTerminal, resolveWithNewAgent } from "./agentInvoker";
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
import { DiffStatus } from "./diffParser";
import { ThreadsTreeProvider } from "./threadsTree";
import { getDefaultTargetBranch } from "./config";

const execFileAsync = promisify(execFile);

// Minimal types for the VS Code built-in Git extension API
interface GitExtensionAPI {
  getRepository(uri: vscode.Uri): GitRepository | null;
}
interface GitRepository {
  getBranches(query: { remote?: boolean; sort?: string }): Promise<GitRef[]>;
}
interface GitRef {
  readonly name?: string;
  readonly remote?: string;
}
interface GitExtension {
  getAPI(version: 1): GitExtensionAPI;
}

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

  let currentSessionId: string | null = null;

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
        void diffPanelManager.refresh(currentSessionId ?? undefined);
      }
    }),
  );

  // Subscribe to file watcher events (replaces WS session-updated)
  context.subscriptions.push(
    sessionWatcher.onDidSessionChange((session) => {
      if (!currentSessionId) return;
      const threads = session.threads ?? [];
      outputChannel.appendLine(
        `Session file changed: reconciling ${threads.length} threads for ${currentSessionId}`,
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
      currentSessionId = sessionId;
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
        currentSessionId ?? undefined,
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
    currentSessionId = sessionId;

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
    currentSessionId = newSessionId;
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

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("resolvr.refresh", () => {
      outputChannel.appendLine("Refresh command invoked");
      void init();
    }),
    vscode.commands.registerCommand("resolvr.startReview", async () => {
      const sessionId = branchDetector.sessionId;
      if (!sessionId) {
        void vscode.window.showWarningMessage(
          "No working branch detected. Switch to a non-default branch first.",
        );
        return;
      }

      const existing = await sessionStore.getSession(sessionId);
      if (existing) {
        void vscode.window.showInformationMessage(
          "Review session already exists for this branch.",
        );
        return;
      }

      outputChannel.appendLine(`Creating new review session for ${sessionId}`);
      const session = {
        sessionId,
        worktreePath: workspaceRoot,
        sourceBranch: branchDetector.branchName ?? sessionId,
        targetBranch: resolveTargetBranch(),
        verdict: null as "approved" | "changes_requested" | null,
        threads: [] as SessionThread[],
        metadata: {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };

      try {
        sessionStore.saveSession(sessionId, session);
        currentSessionId = sessionId;
        await hydrateSession(sessionId);
        outputChannel.appendLine("Review session created");
        void vscode.window.showInformationMessage(
          `Review session created for ${sessionId}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Failed to create session: ${msg}`);
        void vscode.window.showErrorMessage(
          `Failed to create review session: ${msg}`,
        );
      }
    }),
    vscode.commands.registerCommand("resolvr.requestChanges", async () => {
      const sessionId = branchDetector.commentSessionId;
      if (!sessionId) {
        void vscode.window.showWarningMessage("No active working branch.");
        return;
      }

      outputChannel.appendLine(
        `Request Changes: setting verdict for ${sessionId}`,
      );

      try {
        await sessionStore.setVerdict(sessionId, "changes_requested");
        void vscode.window.showInformationMessage(
          "Verdict saved. Run /resolve in your Claude session to process threads.",
        );
        outputChannel.appendLine("Verdict set to changes_requested");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Request Changes failed: ${msg}`);
        void vscode.window.showErrorMessage(`Failed to set verdict: ${msg}`);
      }
    }),

    // Diff panel commands
    vscode.commands.registerCommand("resolvr.openDiff", async () => {
      const sessionId = branchDetector.sessionId;
      if (!sessionId) {
        void vscode.window.showWarningMessage(
          "No working branch detected. Switch to a non-default branch first.",
        );
        return;
      }
      try {
        await diffPanelManager.open(sessionId ?? undefined);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`openDiff failed: ${msg}`);
        void vscode.window.showErrorMessage(
          `Resolvr: Failed to open diff — ${msg}`,
        );
      }
    }),

    vscode.commands.registerCommand(
      "resolvr.openDiffFile",
      async (file: unknown) => {
        if (file && typeof file === "object" && "path" in file) {
          await diffPanelManager.openFile(
            file as {
              path: string;
              oldPath: string;
              newPath: string;
              status: DiffStatus;
            },
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "resolvr.goToThread",
      async (filePath: string, line: number) => {
        const fileRef = diffPanelManager.getFileByPath(filePath) ?? {
          path: filePath,
          oldPath: filePath,
          newPath: filePath,
          status: DiffStatus.Modified,
        };
        await diffPanelManager.openFile(fileRef);
        setTimeout(() => {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            const pos = new vscode.Position(Math.max(0, line - 1), 0);
            editor.revealRange(
              new vscode.Range(pos, pos),
              vscode.TextEditorRevealType.InCenter,
            );
          }
        }, 300);
      },
    ),

    vscode.commands.registerCommand("resolvr.refreshDiff", async () => {
      const sessionId = branchDetector.sessionId;
      try {
        await diffPanelManager.refresh(sessionId ?? undefined);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`refreshDiff failed: ${msg}`);
      }
    }),

    vscode.commands.registerCommand("resolvr.closeDiff", () => {
      diffPanelManager.close();
    }),

    // View mode toggle: flat ↔ compact-tree
    vscode.commands.registerCommand("resolvr.toggleFileViewMode", () => {
      diffPanelManager.toggleViewMode();
    }),

    // Change target branch for diff comparisons
    vscode.commands.registerCommand("resolvr.changeTargetBranch", async () => {
      const sessionId = branchDetector.sessionId;
      if (!sessionId) {
        void vscode.window.showWarningMessage(
          "No working branch detected. Switch to a non-default branch first.",
        );
        return;
      }

      // List branches using VS Code Git extension API, fallback to git CLI
      let branchNames: string[] = [];
      try {
        const gitExt =
          vscode.extensions.getExtension<GitExtension>("vscode.git");
        if (gitExt) {
          const git = gitExt.isActive
            ? gitExt.exports
            : await gitExt.activate();
          const api = git.getAPI(1);
          const repo = api.getRepository(vscode.Uri.file(workspaceRoot));
          if (repo) {
            const refs = await repo.getBranches({
              remote: true,
              sort: "committerdate",
            });
            branchNames = refs
              .map((r) => r.name ?? "")
              .filter((n) => n.length > 0);
          }
        }
      } catch {
        // Git extension unavailable — fall back to CLI
      }

      if (branchNames.length === 0) {
        try {
          const { stdout } = await execFileAsync("git", ["branch", "-a"], {
            cwd: workspaceRoot,
          });
          branchNames = stdout
            .split("\n")
            .map((l) => l.replace(/^\*?\s+/, "").trim())
            .filter((l) => l.length > 0 && !l.includes("->"));
        } catch {
          void vscode.window.showErrorMessage("Failed to list branches.");
          return;
        }
      }

      // Get current target for pre-selection (session > workspace state > config)
      const session = await sessionStore.getSession(sessionId);
      const currentTarget = session?.targetBranch ?? resolveTargetBranch();

      const items = branchNames.map((name) => ({
        label: name === currentTarget ? `$(check) ${name}` : name,
        description: name === currentTarget ? "current" : undefined,
        branch: name.replace(/^remotes\//, ""),
      }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Current target: ${currentTarget}`,
        title: "Select Target Branch",
      });

      if (!picked) return;

      const newTarget = picked.branch;
      outputChannel.appendLine(
        `Changing target branch to ${newTarget} for session ${sessionId}`,
      );

      // Persist to session file if one exists, otherwise to workspace state
      if (session) {
        session.targetBranch = newTarget;
        session.metadata.updatedAt = new Date().toISOString();
        sessionStore.saveSession(sessionId, session);
      } else {
        await context.workspaceState.update("targetBranchOverride", newTarget);
      }

      // refresh() resolves base ref and updates the content provider
      await diffPanelManager.refresh(sessionId ?? undefined, newTarget);

      void vscode.window.showInformationMessage(
        `Target branch changed to ${newTarget}`,
      );
    }),

    // Resolve open threads with AI agent
    vscode.commands.registerCommand("resolvr.resolveWithAI", async () => {
      const sessionId = branchDetector.commentSessionId;
      if (!sessionId) {
        void vscode.window.showWarningMessage(
          "No active branch — open a workspace with a git branch first.",
        );
        return;
      }
      const session = await sessionStore.getSession(sessionId);
      if (!session) {
        void vscode.window.showWarningMessage(
          "No review session found. Start a review first.",
        );
        return;
      }

      const choice = await vscode.window.showQuickPick(
        [
          {
            label: "$(terminal) Send to existing terminal",
            description: "Send resolve prompt to an agent already running",
            mode: "existing" as const,
          },
          {
            label: "$(add) Start new agent",
            description: "Spawn a new agent process to resolve threads",
            mode: "new" as const,
          },
        ],
        { placeHolder: "How should the agent be invoked?" },
      );

      if (!choice) return;

      if (choice.mode === "existing") {
        await resolveInExistingTerminal(
          sessionStore.getSessionFilePath(sessionId),
          session,
          workspaceRoot,
          outputChannel,
        );
      } else {
        resolveWithNewAgent(
          sessionStore.getSessionFilePath(sessionId),
          session,
          workspaceRoot,
          outputChannel,
        );
      }
    }),

    // Regenerate agent skill files
    vscode.commands.registerCommand("resolvr.regenerateSkills", async () => {
      const sessionId = branchDetector.commentSessionId;
      if (!sessionId) {
        void vscode.window.showWarningMessage(
          "No active branch — open a workspace with a git branch first.",
        );
        return;
      }
      try {
        const session = await sessionStore.getSession(sessionId);
        const skillContext = await skillGenerator.buildContext(
          sessionId,
          sessionStore.getSessionFilePath(sessionId),
          session,
        );
        await skillGenerator.generate(skillContext, session);
        void vscode.window.showInformationMessage(
          "Agent skill files regenerated in .review/",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(
          `Failed to regenerate skills: ${msg}`,
        );
      }
    }),
  );

  // Run initialization
  void init();
}

export function deactivate(): void {
  // Cleanup handled by disposables in context.subscriptions
}
