# Specification: CLI Feedback Channel

## Motivation

With the browser-annotations spec, Resolvr has two capture surfaces: VS Code inline comments and browser click-to-annotate. Both converge on the same system of record — `.review/sessions/<branch>-code.json` — via the same thread shape. The third surface is the terminal: a developer looking at output from tests, an agent, or a `git diff` wants to file review feedback without opening VS Code or a browser.

The architecture decision (recorded in browser-annotations spec, R3 "Hosting" and NF1) is that **the session files are the integration surface, not a server**. VS Code writes them directly; a CLI can too. HTTP exists solely because a browser page cannot touch the filesystem. So the CLI is not a client of some daemon — it is a second direct writer to the same files, and additionally a second _host_ for the browser capture listener so browser annotation works while VS Code is closed.

This is the smallest of the three specs: the Storage & Git layer (`SessionStore`, atomic writes) already has no `vscode` dependency by design, and `sessionWatcher` already reconciles external writes into a running VS Code.

## Requirements

### R1: Shared thread construction (`threadFactory`)

Thread construction currently lives inline in `commentManager.ts` (~`src/commentManager.ts:350–375`: `randomUUID` ids, `status: "open"`, `severity: "improvement"`, message shape). The browser capture server (browser-annotations R3) mirrors those defaults, and the CLI would be a third copy.

Extract a pure helper before that duplication ships:

- `src/threadFactory.ts` (Logic layer, no `vscode`, no `fs`): `buildThread({ anchor, text, author }): SessionThread` — owns ids, timestamps, `status: "open"`, `severity: "improvement"`, and the single-`human`-message shape.
- `commentManager.ts` refactors onto it (behavior-identical); the capture server (browser-annotations T-3) and this CLI consume it.

### R2: `resolvr comment` — capture from the terminal

```
resolvr comment <file>:<line> "message"
```

- Derives context from git, not VS Code: workspace root via `git rev-parse --show-toplevel` (works in worktrees, where `.git` is a file — see CLAUDE.md gotcha), session id = current branch via `git rev-parse --abbrev-ref HEAD`. Detached HEAD → exit 1 with a one-line error.
- Builds a `diff-line` anchor exactly as VS Code does: reads the file, takes the line's content for `preview` (first 120 chars) and `hash` (first 16 hex chars of SHA-256 of the line content, matching `skillGenerator`'s documented rule at `src/skillGenerator.ts:198`), `side: "new"`. Line out of range → exit 1, no write.
- `ensureSession` + `createThread` via the existing `SessionStore` — same atomic temp-file+rename write. If the session doesn't exist yet, `targetBranch` is auto-detected from git (`main` if it exists, else `master`; overridable with `--target <branch>`) — the CLI cannot read the `resolvr.defaultTargetBranch` VS Code setting and must not try.
- Prints the created thread id. Exit 0.
- `author` defaults to `"CLI"`.

No `dom-element` anchors from the CLI: a terminal user is always talking about a file/line. No anchor-less threads: the schema requires an anchor, and inventing a third variant for MVP is scope creep.

### R3: `resolvr serve` — host the browser capture listener

- Starts the host-agnostic `captureServer` module from browser-annotations T-3 (now built; endpoint surface documented in that spec's "As built" addendum), injecting git-derived deps (`getSessionId` from `git rev-parse --abbrev-ref HEAD`, `ensureSession` defaults as in R2) instead of extension deps. Same port default (`43117`, `--port` to override), same CORS/Origin rules — those live inside the module, not the host.
- Foreground process: logs to stdout, stops on Ctrl-C. Never daemonizes (browser-annotations NF1).
- If VS Code is already hosting the listener, `serve` exits 1 with "port 43117 already in use — VS Code is probably serving" rather than fighting for the port.

**Dependency**: R3 requires browser-annotations T-3 (built 2026-07-07). R1/R2 have no such dependency and can ship independently.

### R3b: `resolvr/vite` plugin — context-carrying dev-server integration

The session-identity rule everywhere else is "derive from the checkout you launched from" (VS Code: workspace root; `resolvr comment`: cwd). The browser breaks that rule — its only binding is "whoever owns the capture port when I POST", which is invisible and can silently be the wrong branch or the wrong repo. The Vite plugin closes the gap by putting resolvr _inside_ the dev-server process, which runs in the project directory and therefore carries the context itself:

```ts
// vite.config.ts
import { resolvrAnnotations } from "@ugudlado1/resolvr/vite";
export default { plugins: [resolvrAnnotations()] };
```

- `src/vitePlugin.ts` → `dist/vite.js`, exposed via `package.json` `exports["./vite"]`. Structurally typed — vite is **not** a dependency (NF3); the plugin implements the stable subset of the Plugin API shape.
- **Same-origin middleware, not a separate server**: `configureServer` mounts the shared `createCaptureHandler` (extracted from `captureServer.ts`; every host uses it) at `/__resolvr/` on the dev server's own origin. No CORS in play, no capture port, no port collisions, works with VS Code closed. The Origin check still applies for defense against cross-origin POSTs from hostile pages.
- **Auto-injection done right**: `transformIndexHtml` adds `<script src="/__resolvr/annotate.js">` — the framework-blessed injection point; no proxy, no rewriting of dev-server responses. `apply: "serve"` keeps production builds untouched. The capture script derives all endpoint URLs from its own `src`, so the same `assets/annotate.js` serves the plugin mount, the standalone port, and console-paste unchanged.
- On dev-server start: resolves repo root/branch from the Vite project root, calls `ensureSession` (targetBranch auto-detected, `targetBranch` plugin option to override) and generates agent context files via `SkillGenerator` — agents pick up browser feedback through the same `.review/AGENTS.md` + session files as every other surface. Failure never breaks the dev server (warn and continue); detached HEAD or non-repo disables annotations with a warning.
- Records the **launch branch**; `GET /__resolvr/context` reports it alongside the per-request current branch so the panel warns on drift (branch switched while the dev server serves stale code). Drift is made visible, not prevented.

**Superseded during design — `resolvr run <cmd>` wrapper**: a generic dev-command wrapper (spawn + co-hosted capture server) was specced, built, and verified first, then removed in favor of the plugin: the plugin gets the same context with same-origin endpoints and true auto-injection, which the wrapper could not do without proxying (rejected: HMR websockets, compression, and HTTP/2 breakage). Non-Vite dev servers use `resolvr serve` + the script tag / bookmarklet; per-framework plugins (Next.js, webpack) can follow the same `createCaptureHandler` pattern if demand appears.

### R4: Build and invocation

- Second and third esbuild entries: `src/cli.ts` → `dist/cli.js` (`#!/usr/bin/env node` banner) and `src/vitePlugin.ts` → `dist/vite.js`. Neither externalizes `vscode` — the build failing on a leaked `vscode` import is the NF1 check. Covered by `make build`.
- `package.json` gains `"bin": { "resolvr": "./dist/cli.js" }` — usable via `pnpm link` or direct `node dist/cli.js` from a checkout. VS Code packaging ignores `bin`; the `.vsix` is unaffected.
- Publishing the CLI to npm as its own package is **out of scope** — in-repo/`pnpm link` distribution until real demand exists.

## Non-Functional Requirements

### NF1: No `vscode` import anywhere in the CLI path

`cli.ts`, `threadFactory.ts`, and everything they pull in must pass the layer grep test (CLAUDE.md): the CLI bundles and runs with no extension host. This is verified by the build itself — esbuild without `--external:vscode` fails loudly if `vscode` leaks into the import graph.

### NF2: Safe concurrent writes with a running VS Code

Both writers use the same atomic temp+rename pattern (`sessionStore.ts:188`), and `sessionWatcher` picks up external writes — this is precisely the path agents already use when they edit session files per `AGENTS.md`. No locking is added; last-writer-wins on the whole file is the existing, accepted model. A CLI write while VS Code holds the same session in memory is reconciled by the watcher re-read, not by merging.

### NF3: No new dependencies

Arg parsing is `process.argv` string handling — two subcommands and three flags do not justify a CLI framework. Git calls go through the same `child_process` pattern `gitDiff.ts` uses.

## User Stories

### US1: Filing feedback from a test run

A developer runs `make test` in a terminal, sees a failure rooted in a sloppy conditional, and runs `resolvr comment src/gitDiff.ts:52 "this swallows the rename case — see failing test"`. The thread appears in VS Code's sidebar the next time (or the moment) VS Code is open on that branch, and "Resolve with AI" picks it up like any other thread.

### US2: Browser annotation with VS Code closed

A developer is testing UI in the browser with VS Code closed. They run `resolvr serve` in a terminal, use the annotation bookmarklet as usual, Ctrl-C when done. The threads are on disk; VS Code hydrates them on next open.

### US3: Dev server with built-in feedback context

A developer adds `resolvrAnnotations()` to their `vite.config.ts` once. From then on, `npm run dev` — unchanged — serves the annotation panel on every page: the panel header shows "myrepo @ feature/settings-page", every annotation lands in that session, and a warning appears if they switch branches while the dev server keeps serving old code. Nothing to remember to run, nothing to paste.

## Future Enhancement (build only after the MVP loop proves itself)

### FE1: `resolvr poll` — blocking feedback channel for live agents

Adopted from [lavish-axi](https://github.com/kunchenguid/lavish-axi)'s pull model: instead of pushing feedback to an agent (which requires knowing which agent, where), the agent _pulls_ — it runs a CLI command that blocks until feedback exists and receives it as stdout, inside its normal tool-call loop.

```
resolvr poll [--since <iso-timestamp>]
```

- Watches the current branch's session file (`fs.watch`, same mechanism as `sessionWatcher`) and blocks until a thread is created or updated after `--since` (default: invocation time), then prints the new/changed threads as JSON to stdout and exits 0.
- Closes the known gap where an agent already mid-run never sees annotations submitted after it was spawned: after finishing its assigned threads, the agent holds `resolvr poll` open and picks up fresh browser/CLI/VS Code feedback without being respawned.
- No routing problem to solve — the recipient is whichever process holds the poll open, and the session key is the branch, mirroring lavish's file-path-identity design.
- Companion change: one line in `skillGenerator`'s `AGENTS.md` telling agents the command exists and when to use it.
- Estimated size: ~30 lines on top of T-2's CLI skeleton. **Trigger to build**: the three capture surfaces are working and someone actually hits the "agent finished before I submitted my annotation" annoyance in practice — not before.

## Out of Scope

- **`resolvr resolve` (spawning the AI agent from the CLI)** — `agentInvoker` runs agents in a VS Code terminal today; a headless resolve loop is a different feature with its own UX questions. Capture-only.
- **Anchor-less / session-level comments** — schema requires an anchor; not adding a variant for this.
- **npm distribution** — `pnpm link` / `node dist/cli.js` until someone actually asks.
- **Reading VS Code settings from the CLI** — deliberately not; git-derived defaults + flags only.

## Success Criteria

1. With VS Code closed, `node dist/cli.js comment src/config.ts:3 "test"` exits 0 and the thread (correct hash, preview, defaults) is in `.review/sessions/<branch>-code.json`; opening VS Code shows it in the Threads sidebar with no further action.
2. With VS Code open on the same branch, the same command makes the thread appear in the sidebar within a couple seconds (watcher path), no reload.
3. `node dist/cli.js serve` + the browser bookmarklet round-trips an annotation to disk with VS Code closed.
4. `commentManager`-created threads are byte-identical in shape before and after the `threadFactory` refactor (compare a captured session file).
5. Works from a git worktree checkout.
6. No new npm dependencies; `make build` produces both bundles (and replaces the stale, orphaned `dist/cli.js` from May that nothing currently builds).
7. A Vite app with `resolvrAnnotations()` in its config auto-serves the panel with zero manual injection: the tag is present in served HTML, `/__resolvr/context` reports the correct repo/branch, an annotation submitted through the auto-injected UI lands in the project's session file, and the session + agent context files exist from dev-server start.
8. The browser panel header shows repo @ branch from the context endpoint, and shows a drift warning after switching branches while the dev server keeps running.
