import * as vscode from "vscode";
import * as path from "path";
import type { BranchDetector } from "../branchDetector";
import type { CommentManager } from "../commentManager";
import type { DiffPanelManager } from "../diffPanelManager";
import type { SessionStore, SessionThread } from "../sessionStore";
import type { SessionWatcher } from "../sessionWatcher";
import type { SkillGenerator } from "../skillGenerator";
import type { StatusBar } from "../statusBar";
import type { ThreadsTreeProvider } from "../threadsTree";
import { getDefaultTargetBranch } from "../config";
import { gitRevParse } from "../git";

export interface LifecycleDeps {
  context: vscode.ExtensionContext;
  outputChannel: vscode.OutputChannel;
  workspaceRoot: string;
  sessionStore: SessionStore;
  branchDetector: BranchDetector;
  commentManager: CommentManager;
  diffPanelManager: DiffPanelManager;
  sessionWatcher: SessionWatcher;
  skillGenerator: SkillGenerator;
  statusBar: StatusBar;
  threadsTree: ThreadsTreeProvider;
}

/**
 * Owns all lifecycle state: the currently-hydrated session, the workspace
 * target-branch override, and the subscriptions that react to branch,
 * session-file, and editor changes.
 */
export interface Lifecycle {
  init: () => Promise<void>;
  hydrateSession: (sessionId: string) => Promise<void>;
  /** Live read of the currently-hydrated sessionId (may be set by auto-create). */
  currentSessionId: () => string | null;
  /** Resolves target branch: workspace-state override > config setting. */
  resolveTargetBranch: () => string;
  /** Wire branch-change, workspace-event, and file-watch subscribers. */
  subscribe: () => void;
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const {
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
  } = deps;

  // Currently-hydrated sessionId. Usually equals branchDetector.sessionId, but
  // diverges on default branches when a session is auto-created from a comment
  // (in that case the value is the commentSessionId).
  let _currentSessionId: string | null = null;

  const currentSessionId = () => _currentSessionId;

  const resolveTargetBranch = (): string => {
    const override = context.workspaceState.get<string>("targetBranchOverride");
    return override ?? getDefaultTargetBranch();
  };

  /** Resolve workspace name from git repo root (handles worktrees). */
  const resolveWorkspace = async (): Promise<void> => {
    try {
      const stdout = await gitRevParse(workspaceRoot, "--git-common-dir");
      const gitCommonDir = path.resolve(workspaceRoot, stdout);
      const repoName = path.basename(path.dirname(gitCommonDir));
      sessionStore.setWorkspaceName(repoName);
      outputChannel.appendLine(`Workspace resolved: ${repoName}`);
    } catch {
      const fallback = path.basename(workspaceRoot);
      sessionStore.setWorkspaceName(fallback);
      outputChannel.appendLine(`Workspace fallback: ${fallback}`);
    }
  };

  const populateDiffs = async (sessionId?: string): Promise<void> => {
    const targetBranch = resolveTargetBranch();
    await diffPanelManager.populate(sessionId, targetBranch);
    statusBar.setReady(0);
    outputChannel.appendLine(
      `Diffs populated (target: ${targetBranch}, session: ${sessionId ?? "none"})`,
    );
  };

  /** Hydrate session-dependent features — only call when session file exists. */
  const hydrateSession = async (sessionId: string): Promise<void> => {
    try {
      const session = await sessionStore.getSession(sessionId);
      if (!session) return;

      _currentSessionId = sessionId;

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

      sessionWatcher.watch(sessionStore.getSessionFilePath(sessionId));

      await diffPanelManager.populate(sessionId);
      diffPanelManager.updateThreadCounts(threads);

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

  const init = async (): Promise<void> => {
    await resolveWorkspace();
    const sessionId = await branchDetector.initialize();
    _currentSessionId = sessionId;

    if (!sessionId) {
      statusBar.setNoBranch();
      outputChannel.appendLine(
        "On default branch — populating working-tree diffs",
      );
      await populateDiffs();
      return;
    }

    outputChannel.appendLine(`Working branch detected: ${sessionId}`);
    await populateDiffs(sessionId);

    const existingSession = await sessionStore.getSession(sessionId);
    if (existingSession) await hydrateSession(sessionId);
  };

  const subscribeBranchChanges = (): void => {
    branchDetector.onDidChangeBranch(async (newSessionId) => {
      outputChannel.appendLine(
        `Branch changed — session: ${newSessionId ?? "none"}`,
      );
      _currentSessionId = newSessionId;
      sessionWatcher.unwatch();

      if (!newSessionId) {
        commentManager.loadThreads([]);
        threadsTree.updateThreads([]);
        statusBar.setNoBranch();
        await populateDiffs();
        return;
      }

      await populateDiffs(newSessionId);

      const existingSession = await sessionStore.getSession(newSessionId);
      if (existingSession) await hydrateSession(newSessionId);
    });
  };

  const subscribeConfigChanges = (): void => {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("resolvr.defaultTargetBranch")) {
          const newTarget = getDefaultTargetBranch();
          outputChannel.appendLine(
            `Target branch setting changed to "${newTarget}"`,
          );
          void branchDetector.initialize();
        }
        if (e.affectsConfiguration("resolvr.diffBase")) {
          outputChannel.appendLine(
            `Diff base mode changed — refreshing diff tree`,
          );
          void diffPanelManager.refresh(_currentSessionId ?? undefined);
        }
      }),
    );
  };

  const subscribeSessionWatcher = (): void => {
    context.subscriptions.push(
      sessionWatcher.onDidSessionChange((session) => {
        if (!_currentSessionId) return;
        const threads = session.threads ?? [];
        outputChannel.appendLine(
          `Session file changed: reconciling ${threads.length} threads for ${_currentSessionId}`,
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
  };

  const subscribeCommentEvents = (): void => {
    // Auto-created session (first comment on a branch with no session file).
    context.subscriptions.push(
      commentManager.onDidCreateSession(async (sessionId) => {
        _currentSessionId = sessionId;
        await hydrateSession(sessionId);
      }),
    );

    // In-process status changes (resolve, wontfix, etc.). The file watcher is
    // suppressed on self-writes, so refresh views manually here.
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
        // Reconcile inline comments — needed when the status change
        // originated from the threads tree view (no inline thread to mutate).
        commentManager.loadThreads(threads);
      }),
    );
  };

  /** Debounced diff refresh when the user edits files in the workspace. */
  const subscribeFileChanges = (): void => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const isNoisyPath = (fsPath: string) =>
      !fsPath.startsWith(workspaceRoot) ||
      fsPath.includes(`${path.sep}node_modules${path.sep}`) ||
      fsPath.includes(`${path.sep}.review${path.sep}`);
    const debouncedRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        outputChannel.appendLine("File change detected — refreshing diff tree");
        void diffPanelManager.refresh(
          _currentSessionId ?? undefined,
          resolveTargetBranch(),
        );
      }, 1000);
    };

    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (!isNoisyPath(doc.uri.fsPath)) debouncedRefresh();
      }),
      vscode.workspace.onDidCreateFiles((e) => {
        if (e.files.some((f) => !isNoisyPath(f.fsPath))) debouncedRefresh();
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        if (e.files.some((f) => !isNoisyPath(f.fsPath))) debouncedRefresh();
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        if (e.files.some((f) => !isNoisyPath(f.newUri.fsPath)))
          debouncedRefresh();
      }),
      { dispose: () => refreshTimer && clearTimeout(refreshTimer) },
    );
  };

  const subscribe = (): void => {
    subscribeBranchChanges();
    subscribeConfigChanges();
    subscribeSessionWatcher();
    subscribeCommentEvents();
    subscribeFileChanges();
  };

  return {
    init,
    hydrateSession,
    currentSessionId,
    resolveTargetBranch,
    subscribe,
  };
}
