# Changelog

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
