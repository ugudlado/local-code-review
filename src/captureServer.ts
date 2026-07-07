import * as http from "http";
import * as fs from "fs";
import { randomUUID } from "crypto";
import type { SessionStore, SessionThread } from "./sessionStore";
import { buildThread } from "./threadFactory";

/**
 * Matches localhost origins in the form `http://localhost[:port]` or
 * `http://127.0.0.1[:port]`. Anchored on both ends so `http://localhost.evil.com`
 * (or trailing-path variants) do not match.
 */
const LOCALHOST_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isLocalhostOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return LOCALHOST_ORIGIN_RE.test(origin);
}

const LOCALHOST_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * DNS-rebinding defense: a hostile domain re-resolving to 127.0.0.1 makes the
 * browser treat its requests as same-origin (no Origin header), bypassing the
 * Origin check — but the Host header still carries the attacker's hostname.
 * Legitimate requests always arrive with a localhost Host.
 */
export function isLocalhostHost(host: string | undefined): boolean {
  if (!host) return false;
  return LOCALHOST_HOST_RE.test(host);
}

export interface AnnotateRequestBody {
  url: string;
  selector: string;
  label: string;
  comment: string;
  viewport?: { width: number; height: number };
}

/**
 * Validate a parsed JSON body against the shape the browser capture script
 * sends. Returns the narrowed body or an error message — pure, no I/O, so
 * it's unit-testable without a running server.
 */
export function validateAnnotateBody(
  body: unknown,
): { ok: true; value: AnnotateRequestBody } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  const requiredStringFields: Array<keyof AnnotateRequestBody> = [
    "url",
    "selector",
    "label",
    "comment",
  ];
  for (const field of requiredStringFields) {
    if (typeof b[field] !== "string" || (b[field] as string).length === 0) {
      return { ok: false, error: `Missing or invalid field: ${field}` };
    }
  }
  let viewport: { width: number; height: number } | undefined;
  if (b.viewport !== undefined) {
    const v = b.viewport as Record<string, unknown>;
    if (
      typeof v !== "object" ||
      v === null ||
      typeof v.width !== "number" ||
      typeof v.height !== "number"
    ) {
      return { ok: false, error: "Invalid viewport" };
    }
    viewport = { width: v.width, height: v.height };
  }
  return {
    ok: true,
    value: {
      url: b.url as string,
      selector: b.selector as string,
      label: b.label as string,
      comment: b.comment as string,
      viewport,
    },
  };
}

/** What GET /context reports — lets the browser panel show where annotations land. */
export interface CaptureContext {
  workspaceName: string;
  workspaceRoot: string;
  branch: string | null;
  sessionId: string | null;
  /** Branch at host launch (resolvr run) — differs from `branch` after a mid-run switch. */
  launchBranch?: string;
}

export interface CaptureHandlerDeps {
  /** Current session id (branch-derived), or null/undefined if none detected. */
  getSessionId: () => string | null | undefined;
  /** Defaults used to auto-create a session if one doesn't exist yet. */
  ensureSessionDefaults: () => {
    worktreePath: string;
    sourceBranch: string;
    targetBranch: string;
  };
  /** Store used for ensureSession()/createThread()/getSession()/updateThread(). */
  sessionStore: Pick<
    SessionStore,
    "ensureSession" | "createThread" | "getSession" | "updateThread"
  >;
  /** Live context for GET /context (panel header + branch-drift warning). */
  getContext: () => CaptureContext;
  /** Absolute path of the capture script served at GET /annotate.js. */
  annotateScriptPath: string;
  log: (msg: string) => void;
}

export interface CaptureServerDeps extends CaptureHandlerDeps {
  /** Port to bind on 127.0.0.1. */
  port: number;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function applyCors(
  res: http.ServerResponse,
  origin: string,
  methods: string,
): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf-8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Shared POST preamble: Origin check (reject non-localhost outright, before
 * reading the body), CORS headers, body read + JSON parse. Returns the parsed
 * body, or undefined if a response has already been sent.
 */
async function readJsonPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<unknown | undefined> {
  const origin = req.headers.origin;
  if (origin !== undefined && !isLocalhostOrigin(origin)) {
    sendJson(res, 403, { error: "Origin not allowed" });
    return undefined;
  }
  if (origin !== undefined) {
    applyCors(res, origin, "POST, OPTIONS");
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendJson(res, 400, { error: `Failed to read body: ${String(err)}` });
    return undefined;
  }

  try {
    return raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: "Malformed JSON body" });
    return undefined;
  }
}

async function handleAnnotate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CaptureHandlerDeps,
): Promise<void> {
  const parsed = await readJsonPost(req, res);
  if (parsed === undefined) return;

  const validated = validateAnnotateBody(parsed);
  if (!validated.ok) {
    sendJson(res, 400, { error: validated.error });
    return;
  }

  const sessionId = deps.getSessionId();
  if (!sessionId) {
    sendJson(res, 409, { error: "No working branch detected" });
    return;
  }

  const { url, selector, label, comment, viewport } = validated.value;

  const thread = buildThread({
    anchor: { type: "dom-element", url, selector, label, viewport },
    text: comment,
    author: "Browser",
  });

  try {
    await deps.sessionStore.ensureSession(
      sessionId,
      deps.ensureSessionDefaults(),
    );
    await deps.sessionStore.createThread(sessionId, thread);
  } catch (err) {
    deps.log(`captureServer: failed to write thread — ${String(err)}`);
    sendJson(res, 500, { error: "Failed to persist thread" });
    return;
  }

  deps.log(`captureServer: created thread ${thread.id} for ${sessionId}`);
  sendJson(res, 201, { id: thread.id });
}

/** POST /reply { threadId, text } — append a human message to an existing thread. */
async function handleReply(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CaptureHandlerDeps,
): Promise<void> {
  const parsed = await readJsonPost(req, res);
  if (parsed === undefined) return;

  const b = parsed as Record<string, unknown>;
  if (
    typeof b.threadId !== "string" ||
    typeof b.text !== "string" ||
    !b.text.trim()
  ) {
    sendJson(res, 400, { error: "Missing or invalid field: threadId/text" });
    return;
  }

  const sessionId = deps.getSessionId();
  if (!sessionId) {
    sendJson(res, 409, { error: "No working branch detected" });
    return;
  }

  try {
    await deps.sessionStore.updateThread(sessionId, b.threadId, {
      messages: [
        {
          id: randomUUID(),
          authorType: "human",
          author: "Browser",
          text: b.text.trim(),
          createdAt: new Date().toISOString(),
        },
      ],
    });
  } catch (err) {
    // updateThread throws on unknown session or thread — surface as 404.
    sendJson(res, 404, {
      error: String(err instanceof Error ? err.message : err),
    });
    return;
  }

  deps.log(`captureServer: reply added to thread ${b.threadId}`);
  sendJson(res, 200, { ok: true });
}

const BROWSER_SETTABLE_STATUSES = new Set(["open", "resolved"]);

/** POST /status { threadId, status } — resolve or reopen a thread from the browser. */
async function handleStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CaptureHandlerDeps,
): Promise<void> {
  const parsed = await readJsonPost(req, res);
  if (parsed === undefined) return;

  const b = parsed as Record<string, unknown>;
  if (
    typeof b.threadId !== "string" ||
    typeof b.status !== "string" ||
    !BROWSER_SETTABLE_STATUSES.has(b.status)
  ) {
    sendJson(res, 400, { error: "Missing or invalid field: threadId/status" });
    return;
  }

  const sessionId = deps.getSessionId();
  if (!sessionId) {
    sendJson(res, 409, { error: "No working branch detected" });
    return;
  }

  try {
    await deps.sessionStore.updateThread(sessionId, b.threadId, {
      status: b.status as SessionThread["status"],
    });
  } catch (err) {
    sendJson(res, 404, {
      error: String(err instanceof Error ? err.message : err),
    });
    return;
  }

  deps.log(`captureServer: thread ${b.threadId} status → ${b.status}`);
  sendJson(res, 200, { ok: true });
}

/** Public shape returned by GET /annotations — mirrors dom-element threads only. */
export interface AnnotationSummary {
  id: string;
  url: string;
  selector: string;
  label: string;
  status: string;
  messages: Array<{
    authorType: string;
    author: string;
    text: string;
    createdAt: string;
  }>;
}

async function handleGetAnnotations(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CaptureHandlerDeps,
): Promise<void> {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!isLocalhostOrigin(origin)) {
      sendJson(res, 403, { error: "Origin not allowed" });
      return;
    }
    applyCors(res, origin, "GET, OPTIONS");
  }

  const fullUrl = new URL(req.url ?? "", "http://127.0.0.1");
  const pageUrl = fullUrl.searchParams.get("url");
  if (!pageUrl) {
    sendJson(res, 400, { error: "Missing url query parameter" });
    return;
  }

  const sessionId = deps.getSessionId();
  if (!sessionId) {
    sendJson(res, 200, { annotations: [] });
    return;
  }

  let session;
  try {
    session = await deps.sessionStore.getSession(sessionId);
  } catch (err) {
    deps.log(`captureServer: failed to read session — ${String(err)}`);
    sendJson(res, 500, { error: "Failed to read session" });
    return;
  }

  const annotations: AnnotationSummary[] = (session?.threads ?? [])
    .filter((t) => t.anchor.type === "dom-element" && t.anchor.url === pageUrl)
    .map((t) => {
      const anchor = t.anchor as Extract<
        typeof t.anchor,
        { type: "dom-element" }
      >;
      return {
        id: t.id,
        url: anchor.url,
        selector: anchor.selector,
        label: anchor.label,
        status: t.status,
        messages: t.messages.map((m) => ({
          authorType: m.authorType,
          author: m.author,
          text: m.text,
          createdAt: m.createdAt,
        })),
      };
    });

  sendJson(res, 200, { annotations });
}

/** Shared GET preamble: Origin check + CORS. Returns false if a 403 was sent. */
function allowGet(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!isLocalhostOrigin(origin)) {
      sendJson(res, 403, { error: "Origin not allowed" });
      return false;
    }
    applyCors(res, origin, "GET, OPTIONS");
  }
  return true;
}

function handleGetContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CaptureHandlerDeps,
): void {
  if (!allowGet(req, res)) return;
  sendJson(res, 200, deps.getContext());
}

function handleGetAnnotateScript(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CaptureHandlerDeps,
): void {
  if (!allowGet(req, res)) return;
  fs.readFile(deps.annotateScriptPath, "utf-8", (err, script) => {
    if (err) {
      deps.log(`captureServer: cannot read annotate script — ${String(err)}`);
      sendJson(res, 500, { error: "annotate.js not available" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Content-Length": Buffer.byteLength(script),
    });
    res.end(script);
  });
}

function handleOptions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  methods: string,
): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && isLocalhostOrigin(origin)) {
    applyCors(res, origin, methods);
  }
  res.writeHead(204);
  res.end();
}

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CaptureHandlerDeps,
) => void | Promise<void>;

const POST_ROUTES: Record<string, RouteHandler> = {
  "/annotate": handleAnnotate,
  "/reply": handleReply,
  "/status": handleStatus,
};

const GET_ROUTES: Record<string, RouteHandler> = {
  "/annotations": handleGetAnnotations,
  "/context": handleGetContext,
  "/annotate.js": handleGetAnnotateScript,
};

/**
 * Plain (req, res) handler for the capture routes. Used by both hosts:
 * `startCaptureServer` wraps it in its own `http.Server`, and the Vite
 * plugin mounts it as connect middleware on the dev server (connect strips
 * the mount prefix, so pathnames match unchanged).
 */
export function createCaptureHandler(
  deps: CaptureHandlerDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    // Unconditional, before any route: reject DNS-rebound requests.
    if (!isLocalhostHost(req.headers.host)) {
      sendJson(res, 403, { error: "Bad Host" });
      return;
    }

    const pathname = (req.url ?? "").split("?")[0];

    const postHandler = POST_ROUTES[pathname];
    if (postHandler) {
      if (req.method === "OPTIONS") {
        handleOptions(req, res, "POST, OPTIONS");
      } else if (req.method === "POST") {
        void postHandler(req, res, deps);
      } else {
        sendJson(res, 404, { error: "Not found" });
      }
      return;
    }

    const getHandler = GET_ROUTES[pathname];
    if (getHandler) {
      if (req.method === "OPTIONS") {
        handleOptions(req, res, "GET, OPTIONS");
      } else if (req.method === "GET") {
        void getHandler(req, res, deps);
      } else {
        sendJson(res, 404, { error: "Not found" });
      }
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  };
}

/**
 * Start the localhost-only capture listener. Resolves to the started
 * `http.Server` once it is actually listening, or `undefined` if binding
 * failed (e.g. EADDRINUSE) — callers should treat `undefined` as "no
 * listener available" and continue without failing activation.
 */
export function startCaptureServer(
  deps: CaptureServerDeps,
): Promise<http.Server | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: http.Server | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const server = http.createServer(createCaptureHandler(deps));

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        deps.log(
          `captureServer: port ${deps.port} already in use — capture endpoint disabled`,
        );
      } else {
        deps.log(`captureServer: failed to start — ${String(err)}`);
      }
      settle(undefined);
    });

    server.on("listening", () => {
      deps.log(`captureServer: listening on 127.0.0.1:${deps.port}`);
      settle(server);
    });

    server.listen(deps.port, "127.0.0.1");
  });
}
