import * as fs from "fs";
import * as path from "path";
import { SessionStore } from "./sessionStore";
import { buildThread, diffLineAnchor } from "./threadFactory";
import { startCaptureServer } from "./captureServer";
import { SkillGenerator } from "./skillGenerator";
import { gitRevParse } from "./git";
import {
  currentBranchSync,
  detectTargetBranch,
  toSessionId,
} from "./repoContext";

// ---------------------------------------------------------------------------
// resolvr CLI — terminal capture (`comment`) and standalone browser-capture
// host (`serve`, for non-Vite dev servers when VS Code is closed; Vite
// projects get the same endpoints via the `resolvr/vite` plugin instead).
// Session identity is "the checkout you launched from" — same rule as the
// VS Code extension and the Vite plugin. No vscode import anywhere in this
// bundle (enforced by the esbuild step, which does NOT externalize vscode
// and fails loudly on a leak).
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  resolvr comment <file>:<line> "message" [--target <branch>]
  resolvr serve [--port <n>] [--target <branch>]

comment  File a review comment on a file/line from the terminal.
serve    Host the browser annotation endpoint (Ctrl-C to stop). For Vite
         projects, prefer the resolvr/vite plugin — it serves the same
         endpoints on the dev server itself, no separate port.`;

const DEFAULT_PORT = 43117;

function fail(msg: string): never {
  process.stderr.write(`resolvr: ${msg}\n`);
  process.exit(1);
}

async function resolveRepoContext(): Promise<{
  workspaceRoot: string;
  branch: string;
  sessionId: string;
}> {
  let workspaceRoot: string;
  try {
    workspaceRoot = await gitRevParse(process.cwd(), "--show-toplevel");
  } catch {
    fail("not inside a git repository");
  }
  const branch = currentBranchSync(workspaceRoot);
  if (!branch) fail("detached HEAD — check out a branch first");
  return { workspaceRoot, branch, sessionId: toSessionId(branch) };
}

/** Pull `--flag value` out of argv; returns [value, remaining argv]. */
function takeFlag(
  argv: string[],
  flag: string,
): [string | undefined, string[]] {
  const i = argv.indexOf(flag);
  if (i === -1) return [undefined, argv];
  const value = argv[i + 1];
  if (value === undefined) fail(`${flag} requires a value`);
  return [value, [...argv.slice(0, i), ...argv.slice(i + 2)]];
}

// ---------------------------------------------------------------------------
// comment
// ---------------------------------------------------------------------------

async function cmdComment(argv: string[]): Promise<void> {
  const [target, rest] = takeFlag(argv, "--target");
  const [locator, ...messageParts] = rest;
  const message = messageParts.join(" ").trim();

  const match = locator?.match(/^(.+):(\d+)$/);
  if (!match || !message) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }
  const [, file, lineStr] = match;
  const line = Number(lineStr);

  const { workspaceRoot, branch, sessionId } = await resolveRepoContext();

  const absPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(absPath)) fail(`no such file: ${file}`);
  const relativePath = path.relative(workspaceRoot, absPath);

  const lines = fs.readFileSync(absPath, "utf-8").split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing newline is not a line
  if (line < 1 || line > lines.length) {
    fail(`line ${line} out of range (${file} has ${lines.length} lines)`);
  }

  const thread = buildThread({
    anchor: diffLineAnchor({
      path: relativePath,
      line,
      side: "new",
      lineContent: lines[line - 1],
    }),
    text: message,
    author: "CLI",
  });

  const sessionStore = new SessionStore({ workspaceRoot });
  await sessionStore.ensureSession(sessionId, {
    worktreePath: workspaceRoot,
    sourceBranch: branch,
    targetBranch: detectTargetBranch(workspaceRoot, target),
  });
  await sessionStore.createThread(sessionId, thread);
  process.stdout.write(`${thread.id}\n`);
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

async function cmdServe(argv: string[]): Promise<void> {
  const [portStr, rest] = takeFlag(argv, "--port");
  const [target] = takeFlag(rest, "--target");
  const port = portStr ? Number(portStr) : DEFAULT_PORT;

  const { workspaceRoot, branch, sessionId } = await resolveRepoContext();
  const sessionStore = new SessionStore({ workspaceRoot });

  // Session + agent context files exist before the first annotation — same
  // as the Vite plugin. Never let this block serving.
  try {
    const { session } = await sessionStore.ensureSession(sessionId, {
      worktreePath: workspaceRoot,
      sourceBranch: branch,
      targetBranch: detectTargetBranch(workspaceRoot, target),
    });
    const skillGenerator = new SkillGenerator(workspaceRoot, () =>
      detectTargetBranch(workspaceRoot, target),
    );
    const skillContext = await skillGenerator.buildContext(
      sessionId,
      sessionStore.getSessionFilePath(sessionId),
      session,
    );
    await skillGenerator.generate(skillContext, session);
  } catch (err) {
    process.stderr.write(`resolvr: session setup failed: ${String(err)}\n`);
  }

  const server = await startCaptureServer({
    port,
    getSessionId: () => {
      const current = currentBranchSync(workspaceRoot);
      return current ? toSessionId(current) : null;
    },
    ensureSessionDefaults: () => ({
      worktreePath: workspaceRoot,
      sourceBranch: currentBranchSync(workspaceRoot) ?? branch,
      targetBranch: detectTargetBranch(workspaceRoot, target),
    }),
    sessionStore,
    getContext: () => {
      const current = currentBranchSync(workspaceRoot);
      return {
        workspaceName: path.basename(workspaceRoot),
        workspaceRoot,
        branch: current,
        sessionId: current ? toSessionId(current) : null,
        launchBranch: branch,
      };
    },
    annotateScriptPath: path.join(__dirname, "..", "assets", "annotate.js"),
    log: (msg) => process.stdout.write(`${msg}\n`),
  });
  if (!server) {
    fail(`port ${port} already in use — VS Code is probably serving`);
  }

  process.stdout.write(
    `resolvr: session "${branch}" @ ${workspaceRoot} — annotation endpoint http://127.0.0.1:${port} (Ctrl-C to stop)\n`,
  );
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [, , subcommand, ...argv] = process.argv;
  switch (subcommand) {
    case "comment":
      return cmdComment(argv);
    case "serve":
      return cmdServe(argv);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      process.stdout.write(`${USAGE}\n`);
      return;
    default:
      fail(`unknown command "${subcommand}"\n${USAGE}`);
  }
}

void main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
