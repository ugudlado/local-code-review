import * as vscode from "vscode";
import type {
  SessionThread,
  SessionMessage,
  SessionStore,
} from "./sessionStore";
import { buildThread, diffLineAnchor } from "./threadFactory";
import { ThreadMapper } from "./threadMapper";
import {
  SCHEME_BASE,
  SCHEME_ANNOTATION,
  AnnotationContentProvider,
} from "./baseContentProvider";
import { describeAnchor } from "./anchor";

export class CommentManager implements vscode.Disposable {
  private readonly _onDidUpdateThread = new vscode.EventEmitter<string>();
  /** Fires after a thread status change with the sessionId. */
  readonly onDidUpdateThread = this._onDidUpdateThread.event;

  private readonly _onDidCreateSession = new vscode.EventEmitter<string>();
  /** Fires when a session is auto-created on first comment, with the sessionId. */
  readonly onDidCreateSession = this._onDidCreateSession.event;

  private static readonly STATUS_LABELS: Record<string, string | undefined> = {
    open: undefined,
    resolved: "Resolved",
    wontfix: "Won't Fix",
    outdated: "Outdated",
    approved: "Resolved",
  };

  private static _statusLabel(status: string): string | undefined {
    return CommentManager.STATUS_LABELS[status];
  }
  private _controller: vscode.CommentController;
  private _threadMapper: ThreadMapper;
  private _workspaceRoot: string;
  private _outputChannel: vscode.OutputChannel;
  private _sessionStore: SessionStore;
  private _annotationContentProvider: AnnotationContentProvider;
  private _lastThreads: SessionThread[] = [];
  private _visible = true;

  get threadMapper(): ThreadMapper {
    return this._threadMapper;
  }

  constructor(
    workspaceRoot: string,
    outputChannel: vscode.OutputChannel,
    sessionStore: SessionStore,
    annotationContentProvider: AnnotationContentProvider,
  ) {
    this._workspaceRoot = workspaceRoot;
    this._outputChannel = outputChannel;
    this._sessionStore = sessionStore;
    this._annotationContentProvider = annotationContentProvider;
    this._threadMapper = new ThreadMapper();
    this._controller = vscode.comments.createCommentController(
      "resolvr",
      "Resolvr",
    );

    // Enable the "+" gutter icon on real files and virtual base-content files.
    // SCHEME_ANNOTATION is read-only context for dom-element threads — no "+"
    // affordance makes sense there (there's no line to comment on), so it's
    // deliberately excluded from this whitelist.
    this._controller.commentingRangeProvider = {
      provideCommentingRanges(document: vscode.TextDocument) {
        if (
          document.uri.scheme === "file" ||
          document.uri.scheme === SCHEME_BASE
        ) {
          return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
        }
        return [];
      },
    };

    this._controller.options = {
      placeHolder: "Add a review comment...",
      prompt: "Type your review comment",
    };
  }

  loadThreads(threads: SessionThread[]): void {
    this._lastThreads = threads;
    if (!this._visible) return;
    this._threadMapper.reconcile(threads, (t) => this._createVSCodeThread(t));
  }

  /** Show/hide all comment threads in the editor without losing state. */
  setVisible(visible: boolean): void {
    if (this._visible === visible) return;
    this._visible = visible;
    if (visible) {
      this._threadMapper.reconcile(this._lastThreads, (t) =>
        this._createVSCodeThread(t),
      );
    } else {
      this._threadMapper.clear();
    }
  }

  get visible(): boolean {
    return this._visible;
  }

  /**
   * Register the comment action commands (create, reply, resolve, unresolve).
   * Must be called after the extension context is ready and a sessionId is known.
   * The getSessionId/getBranchName/resolveTargetBranch callbacks are evaluated
   * at command invocation time so they always see the current state.
   */
  setupCommentHandlers(
    context: vscode.ExtensionContext,
    getSessionId: () => string | null,
    getBranchName: () => string | null,
    resolveTargetBranch: () => string,
  ): void {
    const outputChannel = this._outputChannel;
    const ensureSession = async (sessionId: string): Promise<void> => {
      const { created } = await this._sessionStore.ensureSession(sessionId, {
        worktreePath: this._workspaceRoot,
        sourceBranch: getBranchName() ?? sessionId,
        targetBranch: resolveTargetBranch(),
      });
      if (created) {
        outputChannel.appendLine(
          `Auto-created review session for ${sessionId}`,
        );
        this._onDidCreateSession.fire(sessionId);
      }
    };
    context.subscriptions.push(
      // Create a new thread (user types in the "+" gutter inline box)
      // VS Code passes a single CommentReply object with { text, thread }
      vscode.commands.registerCommand(
        "resolvr.createComment",
        async (reply: vscode.CommentReply) => {
          const thread = reply.thread;
          const sessionId = getSessionId();
          if (!sessionId) {
            void vscode.window.showWarningMessage(
              "Resolvr: No active working branch.",
            );
            return;
          }
          if (!reply.text?.trim()) {
            return;
          }
          try {
            // Auto-create session on first comment
            await ensureSession(sessionId);

            const sessionThread = await this._buildNewThread(
              thread,
              reply.text.trim(),
            );
            const updated = await this._sessionStore.createThread(
              sessionId,
              sessionThread,
            );

            // Dispose the temporary VS Code thread, then reconcile
            // from the updated session (single source of truth)
            thread.dispose();
            this.loadThreads(updated.threads);

            this._onDidUpdateThread.fire(sessionId);
            outputChannel.appendLine(
              `Created thread ${sessionThread.id} — ${describeAnchor(sessionThread.anchor)}`,
            );
          } catch (err) {
            outputChannel.appendLine(`Failed to create thread: ${String(err)}`);
            void vscode.window.showErrorMessage(
              `Resolvr: Failed to create comment — ${String(err)}`,
            );
          }
        },
      ),

      // Reply to an existing thread
      vscode.commands.registerCommand(
        "resolvr.replyToComment",
        async (reply: vscode.CommentReply) => {
          const thread = reply.thread;
          const sessionId = getSessionId();
          if (!sessionId) {
            void vscode.window.showWarningMessage(
              "Resolvr: No active working branch.",
            );
            return;
          }
          if (!reply.text?.trim()) {
            return;
          }
          const threadId = this._threadMapper.getSessionId(thread);
          if (!threadId) {
            outputChannel.appendLine(
              "replyToComment: thread not found in mapper — no session ID",
            );
            return;
          }
          const now = new Date().toISOString();
          const newMessage: SessionMessage = {
            id: crypto.randomUUID(),
            authorType: "human",
            author: "Reviewer",
            text: reply.text.trim(),
            createdAt: now,
          };
          try {
            // Send only the new message — sessionStore appends to existing messages
            await this._sessionStore.updateThread(sessionId, threadId, {
              messages: [newMessage],
            });

            // Append the new comment to the VS Code thread
            thread.comments = [
              ...thread.comments,
              this._createComment(newMessage),
            ];

            this._onDidUpdateThread.fire(sessionId);
            outputChannel.appendLine(`Replied to thread ${threadId}`);
          } catch (err) {
            outputChannel.appendLine(`Failed to reply: ${String(err)}`);
            void vscode.window.showErrorMessage(
              `Resolvr: Failed to post reply — ${String(err)}`,
            );
          }
        },
      ),

      // Thread status commands — consolidated handler
      ...this._registerStatusCommands(getSessionId, outputChannel),
    );
  }

  /** Register all thread status change commands (resolve, reopen, wontfix, outdated). */
  private _registerStatusCommands(
    getSessionId: () => string | null,
    outputChannel: vscode.OutputChannel,
  ): vscode.Disposable[] {
    const statusCommands: Array<{
      command: string;
      status: SessionThread["status"];
      label: string;
    }> = [
      {
        command: "resolvr.resolveThread",
        status: "resolved",
        label: "Resolved",
      },
      {
        command: "resolvr.unresolveThread",
        status: "open",
        label: "Re-opened",
      },
      {
        command: "resolvr.wontfixThread",
        status: "wontfix",
        label: "Won't fix",
      },
      {
        command: "resolvr.outdatedThread",
        status: "outdated",
        label: "Outdated",
      },
    ];

    return statusCommands.map(({ command, status, label }) =>
      vscode.commands.registerCommand(command, async (arg: unknown) => {
        const sessionId = getSessionId();
        if (!sessionId) return;

        // Determine session thread ID — arg is either a VS Code CommentThread
        // (from inline comments) or a TreeNode (from threads tree view)
        let threadId: string | undefined;
        let commentThread: vscode.CommentThread | undefined;

        if (
          arg &&
          typeof arg === "object" &&
          "kind" in arg &&
          (arg as { kind: string }).kind === "thread"
        ) {
          // Tree view item
          threadId = (arg as unknown as { thread: { id: string } }).thread.id;
        } else if (arg) {
          // Inline comment thread
          commentThread = arg as vscode.CommentThread;
          threadId = this._threadMapper.getSessionId(commentThread);
        }

        if (!threadId) return;
        const closed = status !== "open";
        try {
          await this._sessionStore.updateThread(sessionId, threadId, {
            status,
          });

          // Update inline comment thread UI if available
          if (commentThread) {
            commentThread.state = closed ? 1 : 0;
            commentThread.contextValue = closed ? "closed" : "open";
            commentThread.collapsibleState = closed
              ? vscode.CommentThreadCollapsibleState.Collapsed
              : vscode.CommentThreadCollapsibleState.Expanded;
            commentThread.label = CommentManager._statusLabel(status);
          }

          this._onDidUpdateThread.fire(sessionId);
          outputChannel.appendLine(`${label} thread ${threadId}`);
        } catch (err) {
          outputChannel.appendLine(
            `Failed to set ${label.toLowerCase()}: ${String(err)}`,
          );
          void vscode.window.showErrorMessage(
            `Resolvr: Failed to set ${label.toLowerCase()} — ${String(err)}`,
          );
        }
      }),
    );
  }

  private async _buildNewThread(
    vsThread: vscode.CommentThread,
    text: string,
  ): Promise<SessionThread> {
    const uri = vsThread.uri;

    // Detect old-side vs new-side from URI scheme
    let relativePath: string;
    let side: "old" | "new";
    if (uri.scheme === SCHEME_BASE) {
      // Virtual URI — old-side comment in diff panel
      relativePath = uri.path.startsWith("/") ? uri.path.slice(1) : uri.path;
      side = "old";
    } else {
      relativePath = vscode.workspace.asRelativePath(uri);
      side = "new";
    }

    // range may be undefined in older VS Code API typings — default to line 0
    const range = vsThread.range ?? new vscode.Range(0, 0, 0, 0);
    const line = range.start.line + 1; // 0-based → 1-based
    const lineEnd = range.end.line + 1;

    const document = await vscode.workspace.openTextDocument(uri);
    const lineContent = document.lineAt(range.start.line).text;

    return buildThread({
      anchor: diffLineAnchor({
        path: relativePath,
        line,
        lineEnd,
        side,
        lineContent,
      }),
      text,
      author: "Reviewer",
    });
  }

  private _createVSCodeThread(
    sessionThread: SessionThread,
  ): vscode.CommentThread | null {
    const comments = sessionThread.messages.map((msg) =>
      this._createComment(msg),
    );

    let filePath: vscode.Uri;
    let range: vscode.Range;

    if (sessionThread.anchor.type === "dom-element") {
      // No source file to anchor to — render on a read-only virtual doc
      // (same trick SCHEME_BASE uses for deleted-file old-side content) so
      // the thread gets the same CommentController widget as diff-line
      // threads: stacked messages, reply box, resolve/reopen commands.
      this._annotationContentProvider.setContent(
        sessionThread.id,
        describeAnchor(sessionThread.anchor),
      );
      filePath = vscode.Uri.parse(`${SCHEME_ANNOTATION}:/${sessionThread.id}`);
      range = new vscode.Range(0, 0, 0, 0);
    } else {
      // Threads may be in anchor format (from VS Code) or flat format (from
      // browser). Normalize to get path, line, lineEnd, side.
      const anchor = sessionThread.anchor;
      const flat = sessionThread as unknown as Record<string, unknown>;
      const threadPath =
        anchor?.path ?? (flat.filePath as string | undefined) ?? "";
      const threadLine = anchor?.line ?? (flat.line as number | undefined) ?? 1;
      const threadLineEnd =
        anchor?.lineEnd ?? (flat.lineEnd as number | undefined);
      const threadSide =
        anchor?.side ?? (flat.side as "old" | "new" | undefined) ?? "new";

      if (!threadPath) {
        this._outputChannel.appendLine(
          `Skipping thread ${sessionThread.id} — no file path`,
        );
        return null;
      }

      // Route old-side threads to virtual URI (visible in diff panel left pane).
      // When no diff is open, the virtual document isn't visible — same as before.
      if (threadSide === "old") {
        filePath = vscode.Uri.parse(`${SCHEME_BASE}:/${threadPath}`);
      } else {
        filePath = vscode.Uri.file(`${this._workspaceRoot}/${threadPath}`);
      }

      // 1-based session lines → 0-based VS Code range
      const startLine = threadLine - 1;
      const endLine = (threadLineEnd ?? threadLine) - 1;
      range = new vscode.Range(startLine, 0, endLine, 0);
    }

    const thread = this._controller.createCommentThread(
      filePath,
      range,
      comments,
    );

    thread.label = CommentManager._statusLabel(sessionThread.status);

    // Non-open threads are collapsed UNLESS the last message is from an agent
    // (user needs to read the agent's response before deciding next action)
    const isNonOpen = sessionThread.status !== "open";
    const lastMsg = sessionThread.messages[sessionThread.messages.length - 1];
    const hasAgentReply = lastMsg?.authorType === "agent" && isNonOpen;

    thread.collapsibleState =
      !isNonOpen || hasAgentReply
        ? vscode.CommentThreadCollapsibleState.Expanded
        : vscode.CommentThreadCollapsibleState.Collapsed;

    // Map all non-open statuses to Resolved in VS Code
    // 0 = Unresolved, 1 = Resolved (CommentThreadState available since VS Code 1.88)
    thread.state = isNonOpen ? 1 : 0;
    thread.contextValue = isNonOpen ? "closed" : "open";

    return thread;
  }

  private _createComment(msg: SessionMessage): vscode.Comment {
    return {
      body: new vscode.MarkdownString(msg.text),
      mode: vscode.CommentMode.Preview,
      author: {
        name: msg.authorType === "agent" ? `🤖 ${msg.author}` : msg.author,
      },
      timestamp: new Date(msg.createdAt),
    };
  }

  dispose(): void {
    this._onDidUpdateThread.dispose();
    this._onDidCreateSession.dispose();
    this._threadMapper.dispose();
    this._controller.dispose();
  }
}
