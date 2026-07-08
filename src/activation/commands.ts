import * as vscode from "vscode";
import type { BranchDetector } from "../branchDetector";
import type { DiffPanelManager } from "../diffPanelManager";
import type { SessionStore } from "../sessionStore";
import type { SkillGenerator } from "../skillGenerator";
import { DiffStatus } from "../diffParser";
import { findAdjacentHunk } from "../fileTree";
import {
  resolveInExistingTerminal,
  resolveWithNewAgent,
} from "../agentInvoker";
import { listBranchesViaCli } from "../git";
import { getCapturePort } from "../config";

// Minimal types for the VS Code built-in Git extension API.
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

export interface CommandDeps {
  context: vscode.ExtensionContext;
  outputChannel: vscode.OutputChannel;
  workspaceRoot: string;
  sessionStore: SessionStore;
  branchDetector: BranchDetector;
  diffPanelManager: DiffPanelManager;
  skillGenerator: SkillGenerator;
  /** Resolved target branch (workspace-state override > config). */
  resolveTargetBranch: () => string;
  /** Full re-initialization (used by the refresh command). */
  init: () => Promise<void>;
  /** Session-dependent feature hydration (used by startReview). */
  hydrateSession: (sessionId: string) => Promise<void>;
}

/** Register every `resolvr.*` command. All command bodies live here. */
export function registerCommands(deps: CommandDeps): void {
  const {
    context,
    outputChannel,
    workspaceRoot,
    sessionStore,
    branchDetector,
    diffPanelManager,
    skillGenerator,
    resolveTargetBranch,
    init,
    hydrateSession,
  } = deps;

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

      try {
        const { created } = await sessionStore.ensureSession(sessionId, {
          worktreePath: workspaceRoot,
          sourceBranch: branchDetector.branchName ?? sessionId,
          targetBranch: resolveTargetBranch(),
        });
        if (!created) {
          void vscode.window.showInformationMessage(
            "Review session already exists for this branch.",
          );
          return;
        }
        outputChannel.appendLine(`Created review session for ${sessionId}`);
        await hydrateSession(sessionId);
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

    vscode.commands.registerCommand("resolvr.toggleFileViewMode", () => {
      diffPanelManager.toggleViewMode();
    }),

    vscode.commands.registerCommand("resolvr.changeTargetBranch", async () => {
      const sessionId = branchDetector.sessionId;
      if (!sessionId) {
        void vscode.window.showWarningMessage(
          "No working branch detected. Switch to a non-default branch first.",
        );
        return;
      }

      const branchNames = await listBranches(workspaceRoot);
      if (branchNames.length === 0) {
        void vscode.window.showErrorMessage("Failed to list branches.");
        return;
      }

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

      if (session) {
        session.targetBranch = newTarget;
        session.metadata.updatedAt = new Date().toISOString();
        sessionStore.saveSession(sessionId, session);
      } else {
        await context.workspaceState.update("targetBranchOverride", newTarget);
      }

      await diffPanelManager.refresh(sessionId ?? undefined, newTarget);

      void vscode.window.showInformationMessage(
        `Target branch changed to ${newTarget}`,
      );
    }),

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

      const filePath = sessionStore.getSessionFilePath(sessionId);
      if (choice.mode === "existing") {
        await resolveInExistingTerminal(
          filePath,
          session,
          workspaceRoot,
          outputChannel,
        );
      } else {
        resolveWithNewAgent(filePath, session, workspaceRoot, outputChannel);
      }
    }),

    vscode.commands.registerCommand("resolvr.nextHunk", async () => {
      await goToAdjacentHunk(diffPanelManager, "next");
    }),

    vscode.commands.registerCommand("resolvr.prevHunk", async () => {
      await goToAdjacentHunk(diffPanelManager, "prev");
    }),

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
          diffPanelManager.files,
          diffPanelManager.baseRef,
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

    vscode.commands.registerCommand(
      "resolvr.copyAnnotationSnippet",
      async () => {
        const snippet = `<script src="http://127.0.0.1:${getCapturePort()}/annotate.js"></script>`;
        await vscode.env.clipboard.writeText(snippet);
        void vscode.window.showInformationMessage(
          "Annotation script tag copied — paste it into your dev page. " +
            "Vite projects: use the resolvr/vite plugin instead (see docs/browser-annotations.md).",
        );
      },
    ),
  );
}

/** Move to the next/prev hunk in the review stream; no-op when there are none. */
async function goToAdjacentHunk(
  diffPanelManager: DiffPanelManager,
  direction: "next" | "prev",
): Promise<void> {
  const flat = diffPanelManager.getHunkStream();
  if (flat.length === 0) return;

  const position = diffPanelManager.getCurrentPosition();
  const result = findAdjacentHunk(
    flat,
    position?.path,
    position?.line,
    direction,
  );
  if (!result) return;

  await diffPanelManager.openFile(result.file, result.hunk.firstChangedNewLine);
}

/** List branches via the VS Code Git extension API, falling back to git CLI. */
async function listBranches(workspaceRoot: string): Promise<string[]> {
  try {
    const gitExt = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (gitExt) {
      const git = gitExt.isActive ? gitExt.exports : await gitExt.activate();
      const api = git.getAPI(1);
      const repo = api.getRepository(vscode.Uri.file(workspaceRoot));
      if (repo) {
        const refs = await repo.getBranches({
          remote: true,
          sort: "committerdate",
        });
        const names = refs.map((r) => r.name ?? "").filter((n) => n.length > 0);
        if (names.length > 0) return names;
      }
    }
  } catch {
    // Fall through to CLI.
  }

  return listBranchesViaCli(workspaceRoot);
}
