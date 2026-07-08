# Changelog

## 1.4.0 — 2026-07-08

- Get Started walkthrough covering the full loop: feature branch, diff view, first comment, resolve with AI, browser and CLI surfaces
- Welcome content in the Threads and Changed Files views, including default-branch guidance
- Open-thread count badge on the Threads view
- New command: Copy Browser Annotation Snippet (script tag with your configured capture port)
- `resolvr serve` writes agent context files at launch, same as the Vite plugin

* Tag pushes now publish to the VS Code Marketplace and npm automatically
  ! Annotations captured on the default branch now appear in VS Code; before, they were saved but never shown
  ! Generated AGENTS.md now matches the real schema: 120-char previews, `approved` status, single branch line

- Dropped the unused `reviewVerdict` and `anchor.screenshot` fields

## 1.3.0 — 2026-07-07

- Hunk navigation: changed files expand to their hunks in the sidebar; click a hunk to open the diff revealed at it, or walk every hunk across all files with `alt+j`/`alt+k` (wraps at the ends)
- Browser element annotations: click any element on a locally running dev page, leave a comment, and it lands as a review thread in the same session "Resolve with AI" picks up
- Browser threads panel: docked page overlay listing the page's annotations with full conversations, reply, resolve/reopen, and a repo @ branch header with a branch-drift warning
- UI Feedback threads render in VS Code through the same comment widget as code threads (reply, resolve, reopen all work), grouped separately in the Threads sidebar
- `resolvr` CLI: `comment <file>:<line>` files a thread from the terminal; `serve` hosts the annotation endpoint when VS Code is closed
- `resolvr/vite` plugin: one line in `vite.config.ts` auto-injects the annotation UI and serves the capture endpoints on the dev server's own origin — no CORS, no separate port
- Agents get `.review/diff-structure.json` (parsed file/hunk model) alongside `AGENTS.md`, so they can address "hunk 2 of src/App.tsx" without re-parsing a patch
- New setting `resolvr.capturePort` (default 43117) for the standalone capture endpoint
  ! `AGENTS.md` documented 16-char line hashes while VS Code wrote 8 — agent-computed hashes could never match; docs now say 8
  ! The first externally-created thread on a fresh branch now appears without a window reload (session watcher armed pre-emptively)
  ! Capture endpoints reject DNS-rebound requests (unconditional localhost Host check on every route)

* Thread construction extracted to `threadFactory.ts` — one source of truth for VS Code, browser, and CLI writers
* Capture routes extracted to a host-agnostic `createCaptureHandler` shared by the extension, CLI, and Vite plugin
* Anchor rendering for agent prompts unified in `describeAnchor` (diff-line output byte-identical)
* npm packaging prepared: 36K tarball (CLI + vite plugin + capture script) via `.npmignore` whitelist, `prepack` builds fresh

## 1.2.0 — 2026-06-05

- Changed Files now opens in tree view by default (toggle to flat still sticks per workspace)
- Show filename for renamed files in the tree
- Diff now uses merge-base by default, matching GitHub's PR view
  ! Fixed parseDiffNumstat to handle git's brace-expansion rename format (was dropping line stats)
  ! Fixed path parsing in diff helpers

* Extracted file-tree building to a pure module (fileTree.ts) with tests
* Added architecture doc describing the four layers (Glue/UI/Storage&Git/Logic)
* Unified session init flow—one path for both auto-create and Start Review
* Lifecycle now owns all subscribers and session state
* Refactored command handlers and initialization logic into activation/
* Converted sessionStore to a class (was a module singleton)

## 1.1.1 — 2026-04-30

! Restore demo media on the marketplace listing (switched back to GIF since marketplace strips video tags)

## 1.1.0 — 2026-04-29

- Toggle comment visibility from the status bar (eye icon)
- Working-tree changes now render on the default branch instead of an empty tree
- Add comments on any branch — the default branch no longer blocks new threads

* Comment views moved from Source Control to the Explorer sidebar
* Empty Changed Files state simplified to "No changes detected."
  ! Comments resolved by Claude reflect immediately, no window reload needed
  ! Resolving from the threads tree now updates the inline editor widget too
  ! First-comment auto-created sessions hydrate the file watcher right away

## 1.0.2 — 2026-04-06

- Diff tree refreshes automatically on file save, create, delete, or rename
- Pick which branch to diff against from the Changed Files header or settings
- Changed files show up without needing a review session first
- Status bar tracks branch state: detecting, ready, or in review

* Branch detection works on any branch, not just feature/\* ones
* Codex agent uses `codex exec` for non-interactive runs
  ! Diff no longer breaks when `main` ref is missing (falls back to `master`)
  ! Fixed branch detection on non-feature branches

## 1.0.1 — 2026-04-02

- Fix demo GIF not rendering on marketplace

## 1.0.0 — 2026-04-02

- Extension icon and marketplace branding
- "Resolve with AI" — agent-native code review with skill generator and AI thread resolution

* Rebranded from local-code-review to Resolvr
* Flattened monorepo to single-package VS Code extension
* Enabled esbuild minification
* Refreshed README with demo GIF

- Removed server, UI, plugin, and scripts — VS Code extension only
