import * as fs from "fs";
import * as path from "path";

export interface SessionData {
  sessionId: string;
  worktreePath: string;
  sourceBranch: string;
  targetBranch: string;
  verdict: "approved" | "changes_requested" | null;
  threads: SessionThread[];
  metadata: { createdAt: string; updatedAt: string };
  workspaceName?: string;
}

export type ThreadAnchor =
  | {
      type: "diff-line";
      hash: string;
      path: string;
      preview: string;
      line: number;
      lineEnd?: number;
      side: "old" | "new";
    }
  | {
      type: "dom-element";
      url: string;
      selector: string;
      label: string;
      viewport?: { width: number; height: number };
    };

export interface SessionThread {
  id: string;
  anchor: ThreadAnchor;
  status: "open" | "resolved" | "approved" | "wontfix" | "outdated";
  severity: "critical" | "improvement" | "style" | "question";
  messages: SessionMessage[];
  lastUpdatedAt: string;
  labels?: Record<string, string>;
  resolvedByModel?: string;
  resolvedWithSeverity?: string;
}

export interface SessionMessage {
  id: string;
  authorType: "human" | "agent";
  author: string;
  text: string;
  createdAt: string;
}

export interface SessionStoreOptions {
  workspaceRoot: string;
  /** Optional human-readable workspace name stamped into each session file. */
  workspaceName?: string;
  /** Invoked before every write — used by sessionWatcher to suppress its echo. */
  onBeforeWrite?: () => void;
}

type ThreadPatch = Partial<
  Pick<SessionThread, "status" | "severity" | "messages" | "labels">
>;

export class SessionStore {
  private readonly workspaceRoot: string;
  private workspaceName: string | undefined;
  private readonly onBeforeWrite: (() => void) | undefined;

  constructor(opts: SessionStoreOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.workspaceName = opts.workspaceName;
    this.onBeforeWrite = opts.onBeforeWrite;
  }

  setWorkspaceName(name: string): void {
    this.workspaceName = name;
  }

  getSessionFilePath(sessionId: string): string {
    return path.join(
      this.workspaceRoot,
      ".review",
      "sessions",
      `${sessionId}-code.json`,
    );
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    const filePath = this.getSessionFilePath(sessionId);
    try {
      const raw = await fs.promises.readFile(filePath, "utf-8");
      return JSON.parse(raw) as SessionData;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(
        `Failed to read session for ${sessionId}: ${String(err)}`,
      );
    }
  }

  saveSession(sessionId: string, session: SessionData): void {
    this.write(sessionId, session);
  }

  /**
   * Create a session if one does not already exist. Returns the resulting
   * session and whether it was newly created. The single point of truth for
   * what a fresh session looks like — both the "Start Review" command and
   * the auto-create-on-first-comment path go through here so they cannot
   * drift apart.
   */
  async ensureSession(
    sessionId: string,
    defaults: {
      worktreePath: string;
      sourceBranch: string;
      targetBranch: string;
    },
  ): Promise<{ session: SessionData; created: boolean }> {
    const existing = await this.getSession(sessionId);
    if (existing) return { session: existing, created: false };

    const now = new Date().toISOString();
    const session: SessionData = {
      sessionId,
      worktreePath: defaults.worktreePath,
      sourceBranch: defaults.sourceBranch,
      targetBranch: defaults.targetBranch,
      verdict: null,
      threads: [],
      metadata: { createdAt: now, updatedAt: now },
    };
    this.write(sessionId, session);
    return { session, created: true };
  }

  async createThread(
    sessionId: string,
    thread: SessionThread,
  ): Promise<SessionData> {
    const session = await this.requireSession(sessionId);
    session.threads.push(thread);
    this.write(sessionId, session);
    return session;
  }

  async updateThread(
    sessionId: string,
    threadId: string,
    patch: ThreadPatch,
  ): Promise<void> {
    const session = await this.requireSession(sessionId);
    const thread = session.threads.find((t) => t.id === threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);

    if (patch.status !== undefined) thread.status = patch.status;
    if (patch.severity !== undefined) thread.severity = patch.severity;
    if (patch.labels) thread.labels = { ...thread.labels, ...patch.labels };
    // Messages are appended, not replaced (matches server behavior).
    if (patch.messages) thread.messages.push(...patch.messages);
    thread.lastUpdatedAt = new Date().toISOString();

    this.write(sessionId, session);
  }

  async setVerdict(
    sessionId: string,
    verdict: "approved" | "changes_requested",
  ): Promise<void> {
    const session = await this.requireSession(sessionId);
    session.verdict = verdict;
    this.write(sessionId, session);
  }

  private async requireSession(sessionId: string): Promise<SessionData> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`No session found for ${sessionId}`);
    return session;
  }

  private write(sessionId: string, session: SessionData): void {
    const stamped: SessionData = {
      ...session,
      workspaceName: this.workspaceName ?? session.workspaceName,
      metadata: { ...session.metadata, updatedAt: new Date().toISOString() },
    };
    atomicWrite(
      this.getSessionFilePath(sessionId),
      JSON.stringify(stamped, null, 2),
      this.onBeforeWrite,
    );
  }
}

/** Atomic write: temp file + rename to prevent corruption on concurrent writes. */
function atomicWrite(
  filePath: string,
  data: string,
  onBeforeWrite?: () => void,
): void {
  onBeforeWrite?.();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpFile, data);
  fs.renameSync(tmpFile, filePath);
}
