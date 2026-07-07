# Tasks: CLI Feedback Channel

Dependency note: T-1/T-2/T-3 are independent of the browser-annotations spec and can ship alone. T-4/T-4b/T-4c require browser-annotations T-3 (the host-agnostic `captureServer`), built 2026-07-07.

## Phase 1: Shared thread construction

### T-1: Extract `threadFactory.ts`

**Why**: R1 — thread construction is about to have three writers (VS Code, capture server, CLI); extract the single source of truth before the second and third copies exist.

**Files**:

- `src/threadFactory.ts` (new, Logic layer — no `vscode`, no `fs`): `buildThread({ anchor, text, author }): SessionThread` owning ids (`crypto.randomUUID`), timestamps, `status: "open"`, `severity: "improvement"`, single-`human`-message shape. Also a `diffLineAnchor({ path, line, lineEnd?, side, lineContent })` helper that computes `preview` (120 chars) and `hash` (first 16 hex of SHA-256 of line content, per `src/skillGenerator.ts:198`).
- `src/commentManager.ts` (~`:350–375`) — refactor onto the factory, behavior-identical.
- `src/threadFactory.test.ts` — shape, defaults, hash correctness against a known SHA-256 vector.

**Verify**:

- `make test` + `make type-check` pass
- A thread created through VS Code after the refactor is shape-identical to one created before (manual diff of a session file)

---

## Phase 2: CLI

### T-2: `src/cli.ts` skeleton + build wiring

**Why**: R4 — a runnable, bundled entry point before any subcommand logic.

**Files**:

- `src/cli.ts` (new) — `process.argv` dispatch for `comment`, `serve`, and `run`, `--help` text, exit codes. No CLI framework (NF3).
- `package.json` — extend the `build`/`watch` scripts (`:282`) with a second esbuild invocation: `src/cli.ts → dist/cli.js`, `--platform=node --format=cjs`, `#!/usr/bin/env node` banner, **no** `--external:vscode` (the build failing on a leaked `vscode` import is the NF1 check); add `"bin": { "resolvr": "./dist/cli.js" }`.
- `Makefile` — no change needed if targets call the pnpm scripts; confirm `make build` emits both bundles.

**Verify**:

- `make build` produces `dist/cli.js`; `node dist/cli.js --help` prints usage and exits 0
- `chmod +x` + shebang works; `pnpm link` exposes `resolvr` on PATH

---

### T-3: `resolvr comment <file>:<line> "message"`

**Why**: R2 — the actual terminal capture path.

**Files**:

- `src/cli.ts` — implement `comment`: workspace root via `git rev-parse --show-toplevel`; branch via `git rev-parse --abbrev-ref HEAD` (detached HEAD → exit 1); read the target file line (out of range → exit 1, no write); build anchor + thread via T-1's factory (`author: "CLI"`); `SessionStore.ensureSession` (targetBranch: `--target` flag, else `main` if `git show-ref` finds it, else `master`) + `createThread`; print thread id.
- Reuse the `child_process` exec pattern from `src/gitDiff.ts` — no new helper layer for three git calls.

**Verify**:

- VS Code closed: command exits 0, thread lands in `.review/sessions/<branch>-code.json` with correct hash/preview/defaults
- VS Code open on the branch: thread appears in the Threads sidebar within a couple seconds, no reload
- Works from a git worktree (`.git` file, not directory)
- Detached HEAD, nonexistent file, and out-of-range line each exit 1 with a one-line error and write nothing
- `resolvr comment` with a malformed locator (`no-colon`) prints usage, exit 1

---

## Phase 3: Browser-capture host (depends on browser-annotations T-3)

### T-4: `resolvr serve`

**Why**: R3 — browser annotation without VS Code running; second host for the same `captureServer` module, proving the host-agnostic boundary.

**Files**:

- `src/cli.ts` — implement `serve`: construct `captureServer` with git-derived deps (`getSessionId` = current branch, `ensureSession` defaults as in T-3), port `43117` / `--port`; log requests to stdout; SIGINT stops cleanly. `EADDRINUSE` → exit 1 with "port already in use — VS Code is probably serving".

**Verify**:

- VS Code closed: `resolvr serve` + bookmarklet round-trips an annotation to the session file (full CORS path, real browser)
- VS Code open (extension already serving): `resolvr serve` exits 1 with the friendly message
- Ctrl-C releases the port immediately (re-run binds successfully)

---

### T-4b: Capture-server context surface (`GET /context`, `GET /annotate.js`)

**Why**: R3b — the browser panel must show which repo @ branch it writes into, and script injection should be a script tag, not a console paste. Host-agnostic: both the extension host and the CLI hosts feed the same deps.

**Files**:

- `src/captureServer.ts` — `GET /context` returns `{ workspaceName, workspaceRoot, branch, sessionId, launchBranch? }` from a new injected `getContext()` dep; `GET /annotate.js` serves the capture script from an injected `annotateScriptPath` (both bundles live in `dist/`, so `path.join(__dirname, "..", "assets", "annotate.js")` works for extension and CLI alike). Same Origin rules as every other route.
- `src/extension.ts` — supply `getContext` (workspace root, live branch; no `launchBranch`) and the script path.
- `assets/annotate.js` — panel header renders `workspaceName @ branch` from `/context`; when `launchBranch` is present and differs from `branch`, show a drift warning banner.

**Verify**:

- `curl http://127.0.0.1:43117/context` shows correct repo/branch under both hosts
- `<script src="http://127.0.0.1:43117/annotate.js">` in a dev page boots the panel with the header
- Switching branches mid-`run` makes the panel show the drift warning after a Refresh

---

### T-4c: `resolvr/vite` plugin

**Why**: R3b — puts resolvr inside the Vite dev-server process, which carries the checkout context itself and can inject + serve everything same-origin. Replaced the originally-planned `resolvr run` wrapper (built, verified, then removed — see spec R3b for the rationale).

**Files**:

- `src/captureServer.ts` — extract `createCaptureHandler(deps)` (plain `(req, res)` handler) so hosts share the routes; `startCaptureServer` wraps it in its own `http.Server`, the plugin mounts it as connect middleware.
- `src/repoContext.ts` (new) — sync git context helpers (`currentBranchSync`, `repoRootSync`, `toSessionId`, `detectTargetBranch`) shared by CLI and plugin.
- `src/vitePlugin.ts` (new) — `resolvrAnnotations(options?)`: `apply: "serve"`; `configureServer` resolves repo/branch from the Vite root, runs `ensureSession` + `SkillGenerator` (never breaks the dev server on failure), mounts the handler at `/__resolvr/`; `transformIndexHtml` injects `<script src="/__resolvr/annotate.js">`. Structurally typed, no vite dependency.
- `assets/annotate.js` — endpoint base derived from `document.currentScript.src` (works for plugin mount, standalone port, and console-paste fallback alike).
- `package.json` — `exports["./vite"]: "./dist/vite.js"`, third esbuild entry.
- `src/cli.ts` — `run` subcommand removed; `comment`/`serve` refactored onto `repoContext.ts`.

**Verify** (done 2026-07-07, real Vite 8 app + real browser):

- Tag auto-injected into served HTML; panel appears with zero manual steps
- `/__resolvr/context` reports correct repo/branch; header renders "repo @ branch"
- Annotation submitted through the auto-injected UI lands in the project's session file with the right selector
- Session + `.review/AGENTS.md` exist from dev-server start; `[resolvr] session ... ready` in vite log
- Charset explicit on `/annotate.js` (`charset=utf-8`) — em-dash mojibake regression caught in-browser and fixed

---

## Phase 4: Deferred (do not build until MVP is validated in real use)

### T-5: `resolvr poll` — blocking feedback pull for live agents

**Why**: spec FE1 — lets an already-running agent wait for fresh feedback (browser/CLI/VS Code) as blocking stdout instead of being respawned. Adopted from lavish-axi's pull model.

**Files**:

- `src/cli.ts` — `poll` subcommand: `fs.watch` on the branch session file, block until a thread is created/updated after `--since` (default: now), print changed threads as JSON, exit 0
- `src/skillGenerator.ts` — one line in `AGENTS.md` documenting the command

**Verify**:

- Deferred — no verification until the trigger in spec FE1 is met (real-world "agent finished before my annotation landed" pain)
