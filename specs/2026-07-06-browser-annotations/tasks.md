# Tasks: Browser Element Annotations

## Phase 1: Anchor Type + Storage

### T-1: Add `dom-element` anchor variant to the session schema

**Why**: R1 — everything else depends on the storage layer accepting a second anchor shape. This must be additive so existing `diff-line` threads and all current VS Code behavior are untouched.

**Files**:

- `src/sessionStore.ts` — extend `SessionThread["anchor"]` from a single-shape type to a discriminated union of `{ type: "diff-line"; ... }` (existing, unchanged) and `{ type: "dom-element"; url; selector; label; screenshot?; viewport? }` (new)
- **Narrowing fallout** — widening the union breaks type-check at every site that reads diff-line fields without narrowing. Known sites (verified by grep, 2026-07-06): `src/agentInvoker.ts:88–89`, `src/skillGenerator.ts:257`, `src/commentManager.ts:162`, `src/threadsTree.ts:95–102`. Each needs an `anchor.type === "diff-line"` narrow (or the `describeAnchor` helper from T-2, if you pull it forward). This is part of T-1, not optional cleanup — `make type-check` cannot pass without it.

**Verify**:

- `make type-check` passes (only after the narrowing above — expect it to fail mid-task, that's the checklist)
- Existing `sessionStore` tests pass unchanged; behavior for `diff-line` threads is untouched
- A hand-constructed session JSON with a `dom-element` thread round-trips through `getSession`/`saveSession` without errors

---

### T-2: Make agent-facing code anchor-agnostic

**Why**: R5 — verification already done (2026-07-06): the agent-facing code is **not** anchor-agnostic. Both files interpolate `anchor.path`/`anchor.line`/`anchor.side`/`anchor.preview` directly, and `skillGenerator` embeds a schema doc describing only the `diff-line` shape. Close the gaps; don't re-verify.

**Files**:

- `src/skillGenerator.ts:257` and `src/agentInvoker.ts:88–89` — replace inline diff-line interpolation with a shared `describeAnchor(anchor): string` helper (one case per anchor type; `dom-element` renders url, selector, label, viewport). Put it in the Logic layer (no `vscode` import) so it's vitest-testable.
- `src/skillGenerator.ts:153–159` — extend the embedded session-schema documentation to describe the `dom-element` anchor variant, so agents reading `AGENTS.md` understand both shapes.

**Verify**:

- Manually add a `dom-element` thread to a test session file, run "Resolve with AI", confirm `.review/AGENTS.md` includes readable context for that thread (url, selector, label, comment text)
- For a session containing only `diff-line` threads, generated `AGENTS.md` and resolve-prompt output are identical to pre-change output (snapshot or manual diff)
- Unit test for `describeAnchor` covering both variants

---

## Phase 2: Local Capture Endpoint

### T-3: Add a single-route localhost listener for thread creation

**Why**: R3, NF1, NF2 — the browser needs somewhere local to POST a new thread to, using the existing `SessionStore.createThread()` path so it behaves identically to a VS Code-created thread (same file, same atomic write, same file-watcher pickup).

**Files**:

- `src/captureServer.ts` (new) — Node built-in `http` module, binds to `127.0.0.1` on port `43117` (new `resolvr.capturePort` setting overrides; read via `src/config.ts`). Routes: `POST /annotate` plus its `OPTIONS` preflight. Parses `{ url, selector, label, comment, viewport }`, builds a `SessionThread` with a `dom-element` anchor and one `human` message (defaults per spec R3: `status: "open"`, `severity: "improvement"`, `author: "Browser"`, ids via `crypto.randomUUID()`), calls `SessionStore.ensureSession()` + `createThread()`.
  - **Session targeting**: constructed with a `getSessionId()` accessor + `ensureSession` defaults, mirroring how `commentManager` gets them (`src/commentManager.ts:112–118`). Returns 409 when `getSessionId()` yields nothing (detached HEAD / no repo), 400 on malformed body.
  - **CORS/Origin** (spec NF2): answer preflight and set `Access-Control-Allow-Origin` only when `Origin` is `http://localhost:*` or `http://127.0.0.1:*`; reject POSTs with a present non-localhost `Origin` (403). Without this, the browser fetch from the dev page fails — curl alone will not catch it.
  - **EADDRINUSE**: log to the Resolvr output channel and continue without the listener; never fail activation.
  - Layer note: this is Storage & Git layer — no `vscode` import. All host-specific inputs are injected: `{ port, getSessionId, ensureSessionDefaults, log }`. This boundary is load-bearing (spec R3 "Hosting"): a future CLI host (`resolvr serve`) must be able to construct the same server with git-derived deps and no extension present. Do not import `branchDetector` or anything vscode-adjacent directly.
- `src/activation/lifecycle.ts` — start `captureServer` alongside existing init, stop it on deactivate

**Verify**:

- With the extension active, `curl -X POST http://127.0.0.1:43117/annotate -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' -d '{"url":"http://localhost:5173","selector":".toggle","label":"button.settings-toggle","comment":"clips off-screen"}'` returns 201
- Same request with `-H 'Origin: https://evil.example'` returns 403; `OPTIONS` preflight with a localhost `Origin` returns the CORS allow headers
- A real browser `fetch()` from a dev page succeeds end-to-end (curl does not exercise CORS)
- The corresponding `.review/sessions/*-code.json` file contains the new thread with a `dom-element` anchor
- `sessionWatcher.ts` picks up the change and the Threads view updates without restarting VS Code
- Server refuses connections from anything other than loopback (verify by binding address, not by testing from another machine)
- Server does not start, and no port is held open, when the extension is not active
- With the port already occupied, the extension still activates and logs the conflict

---

## Phase 3: Browser Capture UI

### T-4: Build the click-to-annotate bookmarklet/injected script

**Why**: R2 — the actual point of contact for the user. Kept intentionally minimal: no build step, no framework, no persisted state beyond the in-progress comment.

**Files**:

- `assets/annotate.js` (new, or similar) — vanilla JS: element hover highlight, click-to-select, inline comment box, computes a CSS selector for the clicked element (tag + id/class + `:nth-of-type` fallback for disambiguation), POSTs to `http://127.0.0.1:43117/annotate` (port baked into the script — matches the `resolvr.capturePort` default from T-3)
- `docs/` — short usage note: how to load the script (bookmarklet install steps, or "paste into devtools console" as the zero-install path); note that a non-default `resolvr.capturePort` means editing the port in the bookmarklet, and that pages served over **https** may block the call to an http localhost endpoint (browser mixed-content/private-network rules) — local http dev servers are the supported path for MVP

**Verify**:

- Loading the script on a locally running dev page and clicking an element shows a highlight + comment box
- Submitting a comment results in a 201 from the capture endpoint and a new thread visible in VS Code's Threads sidebar within a couple seconds
- Script has no dependencies beyond the DOM/fetch APIs already in every browser
- Selector computed for a repeated element (e.g., third `.card` on the page) still uniquely identifies it

---

## Phase 4: Thread Display

### T-5: Render `dom-element` threads in the Threads sidebar

**Why**: R4 — `dom-element` threads have no file/line to anchor an inline VS Code comment to, so they need their own presentation in the existing Threads tree instead of (or in addition to) the CommentController.

**Files**:

- `src/threadsTree.ts` — group `dom-element` threads under a distinct label (e.g. "UI Feedback"), display using `label` and `url`; clicking opens `url` in the default browser
- `src/commentManager.ts` — confirm it already skips non-`diff-line` anchors gracefully (no crash), add an explicit skip if it doesn't

**Verify**:

- A session with both `diff-line` and `dom-element` threads shows both correctly in the Threads sidebar, without errors for the DOM-anchored ones
- Clicking a `dom-element` thread opens the recorded URL in the system default browser
- No crash or console error in the CommentController path when a `dom-element` thread is present in the session

---

## Phase 5: Polish (defer until MVP is validated)

### T-6: Optional screenshot capture

**Why**: NF3/Out-of-scope notes this can wait — ship selector + label first, add visual context only if real usage shows text-only threads aren't enough.

**Files**:

- `assets/annotate.js` — capture a cropped screenshot of the clicked element's bounding box (e.g. via `getDisplayMedia` or a canvas-based DOM screenshot approach — needs its own feasibility check, not assumed here)
- `src/captureServer.ts` — accept and persist the screenshot under `.review/` alongside the session

**Verify**:

- Deferred — no verification needed until this task is picked up
  </content>
