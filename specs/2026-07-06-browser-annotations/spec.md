# Specification: Browser Element Annotations

## Motivation

Resolvr lets a developer comment on diff lines in VS Code and hand the open threads to an AI agent to resolve. That covers code review, but a large class of feedback — "this button is misaligned," "this modal overflows on mobile," "the hover state looks wrong" — is about rendered UI, not source lines. Today that feedback has to be typed out by hand as a chat message to the agent, with no durable record, no thread, and no reuse of the resolve loop Resolvr already has.

Resolvr's session format is anchor-ready in shape: `SessionThread.anchor` is keyed by `type`, with exactly one variant today (`"diff-line"`). The storage layer (`SessionStore`) is genuinely anchor-agnostic — it never reads anchor fields. The consumers are **not**: `agentInvoker.ts:88`, `skillGenerator.ts:257` (and its schema doc block at lines 153–159), `commentManager.ts:162`, and `threadsTree.ts:95–102` all access `anchor.path` / `anchor.line` / `anchor.side` directly. Widening `anchor` to a discriminated union will fail type-check at those sites until each one narrows on `anchor.type`. This is mechanical, bounded work (four files, verified by grep on 2026-07-06), but it is part of this feature, not a free ride.

This spec adds the ability to click an element in a running dev-server page, leave a comment, and have it land in the same `.review/sessions/*.json` file VS Code already reads — so "Resolve with AI" picks up UI feedback exactly the way it picks up code feedback today.

## Why not adopt a third-party browser annotation tool

Several exist (Lavish, Vibe Annotations, MarkUp, AgentEcho) that do click-to-annotate on a page and export or push feedback to an agent. They were considered and rejected for this project specifically:

- They are unverified third-party code (browser extension or `npx`-fetched CLI) with no security review, asked to run with DOM/network access on a developer's active browser session.
- They would introduce a second, incompatible feedback store and a second "send to agent" mechanism, parallel to the one Resolvr already owns and the user already trusts.
- Resolvr's existing architecture (serverless, file-based sessions, terminal-spawned agent) already has 90% of what's needed. The only genuinely new piece is a way to originate a `SessionThread` from a browser click instead of a VS Code line selection.

Building this in-repo keeps the trust boundary the same as the rest of Resolvr: local files, no server, no third-party code with page/network access.

## Requirements

### R1: New anchor type for DOM elements

Add a `dom-element` variant to `SessionThread["anchor"]` alongside the existing `diff-line` variant:

```ts
{
  type: "dom-element";
  url: string;          // page URL the annotation was taken on (e.g. http://localhost:5173/settings)
  selector: string;      // CSS selector (or selector + nth-of-type disambiguation) identifying the element
  label: string;         // short human-readable description, e.g. element tag + visible text, for display when the live DOM isn't available
  screenshot?: string;   // optional path (relative to .review/) to a captured screenshot crop
  viewport?: { width: number; height: number }; // viewport size at capture time, for responsive-bug context
}
```

This is a pure addition to the existing discriminated union in `sessionStore.ts`. No existing field, type, or behavior changes.

### R2: Minimal browser-side capture UI

A small, self-contained injected script (delivered as a bookmarklet or a temporary `<script>` tag added to the dev page — not a published browser extension) that:

- On activation, lets the user click any element on the page.
- Highlights the hovered element before click (visual affordance only).
- On click, opens a small inline text box for a comment.
- On submit, computes a stable CSS selector for the clicked element and POSTs `{ url, selector, label, comment, viewport }` to a local capture endpoint (R3).

The POST from a dev page (e.g. `http://localhost:5173`) to `http://127.0.0.1:<port>` is **cross-origin**, and a JSON body triggers a CORS preflight — the capture endpoint must handle it (see R3). The capture port is baked into the bookmarklet source; the docs (T-4) must tell the user to regenerate the bookmarklet if they change `resolvr.capturePort`.

No annotation state is held in the browser beyond the current in-progress comment — once submitted, the browser's job is done.

### R3: Local capture endpoint

A minimal local HTTP listener (bound to `127.0.0.1` only) that:

- Accepts the POST body from R2.
- Answers the CORS preflight (`OPTIONS`) and sets `Access-Control-Allow-Origin` on responses — but **only for localhost origins** (see NF2).
- Constructs a `SessionThread` with a `dom-element` anchor and a single `human` message containing the comment text.
- Calls the existing `SessionStore.createThread()` (or `ensureSession()` + `createThread()` if no session exists yet) — the same code path VS Code's own comment creation uses.
- Returns 201 with the created thread id; 400 on malformed body; 409 if no working branch is detected (see below).

**Session targeting**: the session id is the current branch name, exactly as the rest of the extension derives it. The listener is constructed with the same deps `commentManager` uses (`src/commentManager.ts:112–118`): a `getSessionId()` accessor backed by `branchDetector`, plus `worktreePath` / `sourceBranch` / `targetBranch` defaults for `ensureSession()`. If no branch is detected (detached HEAD, no repo), return 409 with a short error body rather than inventing a session.

**Thread field defaults** (the POST body carries none of these): `status: "open"`, `severity: "improvement"`, `id`/message `id` via `crypto.randomUUID()`, message `authorType: "human"`, `author: "Browser"` — mirroring the thread construction in `src/commentManager.ts:350–375`.

**Port**: default `43117`, overridable via a new `resolvr.capturePort` setting. On `EADDRINUSE` (e.g. two VS Code windows on different projects), log to the Resolvr output channel and continue without the listener — never fail extension activation over it.

**Hosting**: the listener is a host-agnostic module (Storage & Git layer — no `vscode` import; port, `getSessionId`, and `ensureSession` defaults injected by whoever starts it). It has two hosts:

1. **VS Code extension** (this spec's MVP): started on activation, stopped on deactivate — zero extra steps for the common case where VS Code is open during review.
2. **CLI** (future, see the cli-feedback discussion): a `resolvr serve` command hosts the same module when VS Code isn't running, deriving the session id from `git rev-parse --abbrev-ref HEAD` instead of `branchDetector`. Not built in this spec — the module boundary just must not preclude it.

If both hosts run, the second gets `EADDRINUSE` and logs; harmless, since both write the same session files and the file watcher reconciles. Either way it is only reachable from localhost and is not a general-purpose server: one POST route plus its OPTIONS preflight. The session **files** remain the real integration surface — VS Code and any CLI read/write them directly; HTTP exists only because a browser page cannot.

### R4: Thread display fallback for `dom-element` anchors

`threadsTree.ts` (or wherever threads are listed) must render `dom-element` threads sensibly without a source line to anchor to:

- List them under a "UI Feedback" grouping, showing the `label` and originating `url`.
- Clicking a thread opens the `url` in the user's default browser (best-effort; no attempt to re-locate the element automatically in this iteration).
- `commentManager.ts`'s VS Code CommentController integration is `diff-line`-only and is not required to render `dom-element` threads inline — the Threads sidebar view is sufficient for MVP.

### R5: Make "Resolve with AI" anchor-agnostic

The original hope — that `agentInvoker.ts` and `skillGenerator.ts` serialize anchors generically — was checked and does **not** hold. Known diff-line-specific sites (verified 2026-07-06):

- `src/agentInvoker.ts:88–89` — interpolates `anchor.path`, `anchor.line`, `anchor.side`, `anchor.preview` into the resolve prompt
- `src/skillGenerator.ts:257` — same interpolation into `.review/AGENTS.md`
- `src/skillGenerator.ts:153–159` — the session-schema documentation embedded in `AGENTS.md` describes only the `diff-line` anchor shape; the agent reads this to understand threads, so it must document `dom-element` too

Close these with one small helper — `describeAnchor(anchor): string` with a case per anchor type — used by both files, rather than inline special-casing. For a `dom-element` anchor it renders `url`, `selector`, `label`, and viewport if present.

## Non-Functional Requirements

### NF1: No unattended daemon

The capture listener (R3) runs only while a host runs it — the VS Code extension while active, or (future) an explicit `resolvr serve` in a terminal the user can see and Ctrl-C. It is never a background daemon with its own lifecycle: nothing to install as a service, nothing to forget is running, nothing to version-skew against the extension. This preserves Resolvr's "no server to run" positioning: the session files are the system of record, and the listener is a stateless browser adapter over them.

### NF2: Localhost-only, with Origin check — no token auth

The listener binds to `127.0.0.1` and is not exposed on the network. But localhost binding alone is **not** sufficient: any website open in the user's browser can fire a POST at `127.0.0.1`, and these threads feed "Resolve with AI" — an unchecked endpoint is a prompt-injection channel into the agent. Mitigation, in this order:

1. Only answer the CORS preflight for requests whose `Origin` is a localhost origin (`http://localhost:*`, `http://127.0.0.1:*`); without an approving preflight, the browser never sends the JSON POST.
2. Also reject the POST itself when `Origin` is present and non-localhost (defense against non-preflighted senders).

No token auth beyond that — a static bookmarklet can't hold a rotating secret, and the Origin check closes the realistic attack (a hostile web page), consistent with Resolvr's single-user local model.

### NF3: Selector stability best-effort, not guaranteed

CSS selectors computed from a live DOM can break across code changes (class name churn, reordering). This is acceptable for MVP: the `label` field exists precisely so a human (or the agent) can still make sense of a thread whose selector no longer resolves. Do not over-invest in selector robustness (e.g., visual-diff-based re-anchoring) until real usage shows it's needed.

### NF4: No new external dependencies

The capture script (R2) is vanilla DOM/fetch, no bundler, no framework. The capture endpoint (R3) uses Node's built-in `http` module, not a new dependency like Express, since it needs exactly one route.

## User Stories

### US1: Flagging a UI bug while looking at the running app

A developer has their app running locally and is manually testing a new feature. They notice a settings toggle rendered off-screen on narrower viewports. They trigger the capture bookmarklet, click the toggle, type "clips off-screen below ~768px, needs a responsive fix," and submit. The thread appears in Resolvr's Threads sidebar in VS Code labeled "UI Feedback: button.settings-toggle — clips off-screen below ~768px."

### US2: Resolving UI feedback alongside code review

A developer has both code-review threads (from diff lines) and UI-feedback threads (from R1-R3) open in the same session. They click "Resolve with AI." The agent works through both kinds of threads in one pass, reading the DOM-anchored thread's `url`, `selector`, and `label` from `AGENTS.md` to understand what to fix, exactly as it reads file/line context for code threads.

## Out of Scope

- **Automatic re-anchoring**: if the DOM changes and a selector no longer matches, this spec does not attempt to auto-relocate the element. The `label` and `screenshot` are the fallback context.
- **Live two-way sync between browser and VS Code**: unlike the historical (out-of-repo) server-based design, there is no WebSocket push from the browser back to VS Code beyond the one-shot POST on comment submission. The existing `sessionWatcher.ts` file-watch mechanism already picks up the new thread once it's written to disk — no new sync channel is needed.
- **Cross-browser extension packaging**: R2 is a bookmarklet/inline script for MVP, not a published Chrome/Firefox extension. Packaging as a real extension is a possible future iteration once the interaction model is validated.
- **Screenshot capture UI polish**: `screenshot` in the anchor schema is optional and can be added in a later pass; MVP can ship with `selector` + `label` alone.
- **Multi-page / SPA route tracking**: capturing which SPA "view" was active (as opposed to raw URL) is not handled; `url` is whatever `window.location.href` reports at click time.

## Success Criteria

1. A user can click an element on a locally running dev page and leave a comment without leaving the browser.
2. That comment appears as an open thread in Resolvr's VS Code sidebar within a couple seconds, tagged as UI feedback.
3. "Resolve with AI" processes DOM-anchored threads: the resolve prompt and `.review/AGENTS.md` render `url`/`selector`/`label` for `dom-element` threads via the shared `describeAnchor` helper (R5), and diff-line output is byte-identical to today's.
4. No new npm dependencies are introduced for either the browser capture script or the local endpoint.
5. The capture endpoint only binds to localhost and only exists while a host is running it (the VS Code extension in this iteration); `captureServer.ts` compiles and constructs without any `vscode` import, proving a non-extension host can own it later.

## As built (2026-07-07) — scope grown during implementation

Built and verified end-to-end in a real browser against the installed extension. The capture server's surface grew beyond R3's single route, driven by two accepted requests: a browser-side threads panel with conversation parity, and session-context transparency (see cli-feedback spec R3b for the `resolvr run` rationale). All routes share the same localhost-bind + Origin rules from NF2.

| Route                               | Purpose                                                                                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /annotate`                    | R3 as specced — create a `dom-element` thread                                                                                                                                            |
| `GET /annotations?url=<page>`       | dom-element threads for that URL (id, selector, label, status, full messages) — feeds the browser panel                                                                                  |
| `POST /reply` `{threadId, text}`    | append a human message (`author: "Browser"`); 404 on unknown thread                                                                                                                      |
| `POST /status` `{threadId, status}` | resolve/reopen from the browser; only `open`/`resolved` settable, others 400                                                                                                             |
| `GET /context`                      | `{workspaceName, workspaceRoot, branch, sessionId, launchBranch?}` — panel header + branch-drift warning                                                                                 |
| `GET /annotate.js`                  | serves the capture script (`charset=utf-8`) so injection is a script tag or one-line bookmarklet; the Vite plugin serves the same routes at `/__resolvr/` on the dev server's own origin |

Additional as-built deltas from the specced MVP:

- **Browser panel** (`assets/annotate.js`): docked right-side panel listing the page's annotations with status pills; expanding a thread shows the full conversation (author, timestamp), a reply box, and Resolve/Reopen — parity with the VS Code comment widget rather than R2's capture-only scope. Snapshot semantics: refreshes on action or via the Refresh button, no live polling.
- **VS Code threaded rendering**: `dom-element` threads render through the same `CommentController` widget as diff-line threads, anchored to a read-only `resolvr-annotation:/<threadId>` virtual document (`AnnotationContentProvider`) — R4's "sidebar-only is sufficient" was superseded; clicking a UI Feedback item opens the real conversation, and reply/resolve/reopen work unchanged because those handlers were already anchor-agnostic.
- **Watcher lifecycle fix** (`activation/lifecycle.ts`): the session watcher is armed even when no session file exists yet, so the _first_ externally-created thread on a fresh branch appears without a reload.
- **Known behavior**: VS Code hydrates threads only on non-default branches; annotations captured while the workspace is on `main` land in `main-code.json` but are not displayed. Decoupling thread display from diff review (show threads on any branch) is agreed direction, not yet built.
  </content>
  </invoke>
