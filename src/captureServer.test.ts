import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import {
  isLocalhostHost,
  isLocalhostOrigin,
  startCaptureServer,
  validateAnnotateBody,
} from "./captureServer";
import { SessionStore } from "./sessionStore";

describe("isLocalhostOrigin", () => {
  it("matches http://localhost with no port", () => {
    expect(isLocalhostOrigin("http://localhost")).toBe(true);
  });

  it("matches http://localhost with a port", () => {
    expect(isLocalhostOrigin("http://localhost:5173")).toBe(true);
  });

  it("matches http://127.0.0.1 with a port", () => {
    expect(isLocalhostOrigin("http://127.0.0.1:8080")).toBe(true);
  });

  it("rejects a lookalike domain", () => {
    expect(isLocalhostOrigin("http://localhost.evil.com")).toBe(false);
  });

  it("rejects a subpath appended to the origin", () => {
    expect(isLocalhostOrigin("http://localhost:5173/evil")).toBe(false);
  });

  it("rejects https origins", () => {
    expect(isLocalhostOrigin("https://localhost:5173")).toBe(false);
  });

  it("rejects a non-localhost origin", () => {
    expect(isLocalhostOrigin("https://evil.example")).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isLocalhostOrigin(undefined)).toBe(false);
  });
});

describe("isLocalhostHost", () => {
  it("accepts localhost and loopback hosts with or without port", () => {
    expect(isLocalhostHost("127.0.0.1:43117")).toBe(true);
    expect(isLocalhostHost("localhost:5173")).toBe(true);
    expect(isLocalhostHost("localhost")).toBe(true);
    expect(isLocalhostHost("[::1]:43117")).toBe(true);
  });

  it("rejects DNS-rebinding hosts and absent Host", () => {
    expect(isLocalhostHost("attacker.example:43117")).toBe(false);
    expect(isLocalhostHost("localhost.evil.com:43117")).toBe(false);
    expect(isLocalhostHost(undefined)).toBe(false);
    expect(isLocalhostHost("")).toBe(false);
  });
});

describe("validateAnnotateBody", () => {
  const validBody = {
    url: "http://localhost:5173",
    selector: ".toggle",
    label: "button.settings-toggle",
    comment: "clips off-screen",
  };

  it("accepts a well-formed body without viewport", () => {
    const result = validateAnnotateBody(validBody);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ ...validBody, viewport: undefined });
    }
  });

  it("accepts a well-formed body with viewport", () => {
    const body = { ...validBody, viewport: { width: 375, height: 812 } };
    const result = validateAnnotateBody(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.viewport).toEqual({ width: 375, height: 812 });
    }
  });

  it("rejects a non-object body", () => {
    const result = validateAnnotateBody("not an object");
    expect(result.ok).toBe(false);
  });

  it("rejects null", () => {
    const result = validateAnnotateBody(null);
    expect(result.ok).toBe(false);
  });

  it("rejects a body missing a required field", () => {
    const { comment: _comment, ...rest } = validBody;
    const result = validateAnnotateBody(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("comment");
    }
  });

  it("rejects a body with an empty required field", () => {
    const result = validateAnnotateBody({ ...validBody, label: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed viewport", () => {
    const result = validateAnnotateBody({
      ...validBody,
      viewport: { width: "375" },
    });
    expect(result.ok).toBe(false);
  });
});

/** Minimal real HTTP client — no fetch dependency, matches the browser's request shape. */
function request(
  port: number,
  method: string,
  headers: Record<string, string>,
  body?: string,
  routePath = "/annotate",
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: routePath, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf-8")));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data,
          }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("startCaptureServer (real HTTP round-trip over loopback)", () => {
  let tmpDir: string | undefined;
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  async function boot(
    getSessionId: () => string | null | undefined = () => "test-branch",
  ) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolvr-capture-"));
    const sessionStore = new SessionStore({ workspaceRoot: tmpDir });
    const port = 43117 + Math.floor(Math.random() * 1000);
    server = await startCaptureServer({
      port,
      getSessionId,
      ensureSessionDefaults: () => ({
        worktreePath: tmpDir!,
        sourceBranch: "test-branch",
        targetBranch: "main",
      }),
      sessionStore,
      getContext: () => ({
        workspaceName: "test-repo",
        workspaceRoot: tmpDir!,
        branch: "test-branch",
        sessionId: getSessionId() ?? null,
        launchBranch: "test-branch",
      }),
      annotateScriptPath: path.join(__dirname, "..", "assets", "annotate.js"),
      log: () => {},
    });
    return { port, sessionStore, tmpDir: tmpDir! };
  }

  it("POST with a localhost Origin creates a thread and returns 201", async () => {
    const { port, sessionStore } = await boot();
    const res = await request(
      port,
      "POST",
      { "Content-Type": "application/json", Origin: "http://localhost:5173" },
      JSON.stringify({
        url: "http://localhost:5173",
        selector: ".toggle",
        label: "button.settings-toggle",
        comment: "clips off-screen",
      }),
    );
    expect(res.status).toBe(201);
    const { id } = JSON.parse(res.body);
    expect(typeof id).toBe("string");

    const session = await sessionStore.getSession("test-branch");
    expect(session?.threads).toHaveLength(1);
    expect(session?.threads[0].anchor).toMatchObject({
      type: "dom-element",
      url: "http://localhost:5173",
      selector: ".toggle",
      label: "button.settings-toggle",
    });
    expect(session?.threads[0].messages[0].text).toBe("clips off-screen");
  });

  it("POST with a non-localhost Origin is rejected with 403 and no write", async () => {
    const { port, sessionStore } = await boot();
    const res = await request(
      port,
      "POST",
      { "Content-Type": "application/json", Origin: "https://evil.example" },
      JSON.stringify({
        url: "http://localhost:5173",
        selector: ".x",
        label: "x",
        comment: "hi",
      }),
    );
    expect(res.status).toBe(403);
    const session = await sessionStore.getSession("test-branch");
    expect(session).toBeNull();
  });

  it("OPTIONS preflight from a localhost Origin gets CORS allow headers", async () => {
    const { port } = await boot();
    const res = await request(port, "OPTIONS", {
      Origin: "http://localhost:5173",
    });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
  });

  it("OPTIONS preflight from a non-localhost Origin gets no CORS headers", async () => {
    const { port } = await boot();
    const res = await request(port, "OPTIONS", {
      Origin: "https://evil.example",
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("malformed JSON body returns 400 with no write", async () => {
    const { port, sessionStore } = await boot();
    const res = await request(
      port,
      "POST",
      { "Content-Type": "application/json" },
      "{not json",
    );
    expect(res.status).toBe(400);
    const session = await sessionStore.getSession("test-branch");
    expect(session).toBeNull();
  });

  it("returns 409 when no working branch is detected", async () => {
    const { port } = await boot(() => null);
    const res = await request(
      port,
      "POST",
      { "Content-Type": "application/json" },
      JSON.stringify({
        url: "http://localhost:5173",
        selector: ".x",
        label: "x",
        comment: "hi",
      }),
    );
    expect(res.status).toBe(409);
  });

  it("returns 404 for any route other than /annotate or /annotations", async () => {
    const { port } = await boot();
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/other", method: "GET" },
        (r) => resolve({ status: r.statusCode ?? 0 }),
      );
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(404);
  });

  it("GET /annotations returns dom-element threads matching the page url", async () => {
    const { port } = await boot();
    await request(
      port,
      "POST",
      { "Content-Type": "application/json" },
      JSON.stringify({
        url: "http://localhost:5173/settings",
        selector: ".toggle",
        label: "button.settings-toggle",
        comment: "clips off-screen",
      }),
    );
    await request(
      port,
      "POST",
      { "Content-Type": "application/json" },
      JSON.stringify({
        url: "http://localhost:5173/other-page",
        selector: ".x",
        label: "x",
        comment: "unrelated page",
      }),
    );

    const res = await request(
      port,
      "GET",
      {},
      undefined,
      `/annotations?${new URLSearchParams({ url: "http://localhost:5173/settings" }).toString()}`,
    );
    expect(res.status).toBe(200);
    const { annotations } = JSON.parse(res.body);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({
      url: "http://localhost:5173/settings",
      selector: ".toggle",
      label: "button.settings-toggle",
      status: "open",
    });
    expect(annotations[0].messages[0].text).toBe("clips off-screen");
  });

  it("GET /annotations returns an empty list when no session exists yet", async () => {
    const { port } = await boot();
    const res = await request(
      port,
      "GET",
      {},
      undefined,
      `/annotations?${new URLSearchParams({ url: "http://localhost:5173/" }).toString()}`,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ annotations: [] });
  });

  it("GET /annotations returns 400 when url query param is missing", async () => {
    const { port } = await boot();
    const res = await request(port, "GET", {}, undefined, "/annotations");
    expect(res.status).toBe(400);
  });

  it("POST /reply appends a human message to an existing thread", async () => {
    const { port, sessionStore } = await boot();
    const created = await request(
      port,
      "POST",
      { "Content-Type": "application/json" },
      JSON.stringify({
        url: "http://localhost:5173/",
        selector: ".x",
        label: "x",
        comment: "first",
      }),
    );
    const { id } = JSON.parse(created.body);

    const res = await request(
      port,
      "POST",
      { "Content-Type": "application/json" },
      JSON.stringify({ threadId: id, text: "a follow-up from the browser" }),
      "/reply",
    );
    expect(res.status).toBe(200);

    const session = await sessionStore.getSession("test-branch");
    const thread = session?.threads.find((t) => t.id === id);
    expect(thread?.messages).toHaveLength(2);
    expect(thread?.messages[1]).toMatchObject({
      authorType: "human",
      author: "Browser",
      text: "a follow-up from the browser",
    });
  });

  it("POST /reply to an unknown thread returns 404", async () => {
    const { port } = await boot();
    await request(
      port,
      "POST",
      { "Content-Type": "application/json" },
      JSON.stringify({
        url: "http://localhost:5173/",
        selector: ".x",
        label: "x",
        comment: "seed session",
      }),
    );
    const res = await request(
      port,
      "POST",
      { "Content-Type": "application/json" },
      JSON.stringify({ threadId: "no-such-thread", text: "hello" }),
      "/reply",
    );
    expect(res.status).toBe(404);
  });

  it("POST /status resolves and reopens a thread", async () => {
    const { port, sessionStore } = await boot();
    const created = await request(
      port,
      "POST",
      { "Content-Type": "application/json" },
      JSON.stringify({
        url: "http://localhost:5173/",
        selector: ".x",
        label: "x",
        comment: "to resolve",
      }),
    );
    const { id } = JSON.parse(created.body);

    const resolveRes = await request(
      port,
      "POST",
      { "Content-Type": "application/json" },
      JSON.stringify({ threadId: id, status: "resolved" }),
      "/status",
    );
    expect(resolveRes.status).toBe(200);
    let session = await sessionStore.getSession("test-branch");
    expect(session?.threads.find((t) => t.id === id)?.status).toBe("resolved");

    const reopenRes = await request(
      port,
      "POST",
      { "Content-Type": "application/json" },
      JSON.stringify({ threadId: id, status: "open" }),
      "/status",
    );
    expect(reopenRes.status).toBe(200);
    session = await sessionStore.getSession("test-branch");
    expect(session?.threads.find((t) => t.id === id)?.status).toBe("open");
  });

  it("POST /status rejects statuses the browser may not set", async () => {
    const { port } = await boot();
    const res = await request(
      port,
      "POST",
      { "Content-Type": "application/json" },
      JSON.stringify({ threadId: "whatever", status: "wontfix" }),
      "/status",
    );
    expect(res.status).toBe(400);
  });

  it("GET /context reports the injected workspace context", async () => {
    const { port } = await boot();
    const res = await request(port, "GET", {}, undefined, "/context");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      workspaceName: "test-repo",
      branch: "test-branch",
      sessionId: "test-branch",
      launchBranch: "test-branch",
    });
  });

  it("GET /annotate.js serves the capture script as javascript", async () => {
    const { port } = await boot();
    const res = await request(port, "GET", {}, undefined, "/annotate.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe(
      "application/javascript; charset=utf-8",
    );
    expect(res.body).toContain("__resolvrAnnotate");
  });

  it("rejects a DNS-rebound Host header with 403 on every route", async () => {
    const { port, sessionStore } = await boot();
    const rebound = { Host: "attacker.example:43117" };
    const getRes = await request(port, "GET", rebound, undefined, "/context");
    expect(getRes.status).toBe(403);
    const postRes = await request(
      port,
      "POST",
      { ...rebound, "Content-Type": "application/json" },
      JSON.stringify({
        url: "http://localhost:5173",
        selector: ".x",
        label: "x",
        comment: "rebound",
      }),
    );
    expect(postRes.status).toBe(403);
    expect(await sessionStore.getSession("test-branch")).toBeNull();
  });

  it("GET /annotations rejects a non-localhost Origin with 403", async () => {
    const { port } = await boot();
    const res = await request(
      port,
      "GET",
      { Origin: "https://evil.example" },
      undefined,
      `/annotations?${new URLSearchParams({ url: "http://localhost:5173/" }).toString()}`,
    );
    expect(res.status).toBe(403);
  });
});
