# Tasks: Hunk-Based Diff Navigation

## Phase 1: Parsing (pure)

### T-1: Parse hunks into `DiffFileEntry.hunks`

**Why**: R1 — everything else consumes this model. It's additive to a pure, already-tested module; no `vscode`, no subprocess.

**Files**:

- `src/diffParser.ts` — add `DiffHunk` interface; in the existing per-block walk of `parseDiffFileList` (`src/diffParser.ts:62–69` currently counts +/− lines), also split blocks on `@@` headers and build `hunks: DiffHunk[]` per entry. Parse `@@ -a[,b] +c[,d] @@ section` with counts defaulting to 1 when omitted. Track the new-side line counter through the hunk body to compute `firstChangedNewLine`; record per-hunk `additions`/`deletions` and a trimmed `preview` of the first changed line.
- `src/diffParser.test.ts` — cases: multi-hunk file; omitted-count header (`@@ -1 +1 @@`); pure-deletion hunk (firstChangedNewLine lands on the correct new-side line); renamed file with hunks; added file (one hunk starting at line 1); deleted/binary file (`hunks: []`); section text captured; preview truncation.

**Verify**:

- `make test` and `make type-check` pass
- For a real diff of this repo (`git diff <ref>`), parsed hunk headers match `grep -c '^@@'` per file — spot-check one multi-hunk file by hand

---

### T-2: (file, hunk) stream ordering helper

**Why**: R3's navigation math — next/prev across files with wrapping — is pure and must be testable without an editor.

**Files**:

- `src/fileTree.ts` (or a small new Logic module if it doesn't fit) — `flattenHunks(files): Array<{ file, hunk }>` in tree display order, and `findAdjacentHunk(flat, currentPath, currentLine, direction)` returning the next/prev entry: within the same file, the nearest hunk whose `firstChangedNewLine` is strictly after/before `currentLine`; otherwise the first/last hunk of the adjacent file; wrapping at both ends. No current position → first (next) / last (prev) entry.
- Tests alongside existing `fileTree` tests: middle-of-file, file-boundary crossing, wrap-around, cursor exactly on a hunk's line, single-file single-hunk degenerate case, files with zero hunks skipped.

**Verify**:

- `make test` passes; the helper has no `vscode` import (Logic layer per CLAUDE.md's grep test)

---

## Phase 2: Tree UI

### T-3: Hunk nodes under file nodes + jump-on-click

**Why**: R2 — makes hunks visible and individually openable from the sidebar.

**Files**:

- `src/fileTree.ts` — add `HunkNode` (`kind: "hunk"`) to `TreeNode`; file nodes expose hunk children in both `flat` and `compact-tree` modes
- `src/changedFilesTree.ts` — render hunk nodes: label `@@ <newStart> <section-or-preview>`, description `+x −y`, collapsed by default on the parent file node; files with `hunks.length === 0` stay non-collapsible leaves
- `src/diffPanelManager.ts` — `onDidChangeSelection` (`:86–92`) handles `kind: "hunk"`: call `openFile(node.file)` extended to accept an optional reveal line, passed as `selection` in the `vscode.diff` options (`:206`). Deleted files: open without selection (spec R2).

**Verify**:

- Extension Development Host (F5): a multi-hunk file expands to its hunks; clicking hunk 2 opens the diff editor scrolled to that hunk's first changed line
- Clicking the file node itself still opens at the top, unchanged
- A deleted file and a binary file show no expansion arrow and don't error
- `make type-check` passes; tree still renders correctly in both view modes

---

## Phase 3: Stream navigation

### T-4: `resolvr.nextHunk` / `resolvr.prevHunk`

**Why**: R3 — the review-stream flow, hunk's core UX idea, and the piece that removes per-file click-and-scroll entirely.

**Files**:

- `package.json` — contribute both commands (category "Resolvr") and default keybindings `alt+j`/`alt+k` with `"when": "resolvr.hasDiffPanel"`
- `src/activation/commands.ts` — register handlers: resolve current position from the active editor (match document path via `getFileByPath`, `src/diffPanelManager.ts:46`; cursor line from `activeTextEditor.selection`), call `findAdjacentHunk` (T-2), open the target via the T-3 path. No matching active editor → first/last hunk.
- `src/diffPanelManager.ts` — expose the current `_files` (or a `getHunkStream()` accessor) so the command handler doesn't reach into privates

**Verify**:

- F5: with a multi-file multi-hunk diff, repeated `alt+j` visits every hunk in sidebar order, opens the next file at file boundaries, and wraps from the last hunk to the first
- `alt+k` mirrors in reverse
- Commands are no-ops (no error toast) when the diff panel is empty
- Keybindings inert outside a Resolvr diff context (`when` clause respected)

---

## Phase 4: Agent-readable structure

### T-5: Emit `.review/diff-structure.json`

**Why**: R4 — hunk's `review --json` equivalent: agents get file/hunk structure without re-running and parsing `git diff`.

**Files**:

- `src/skillGenerator.ts` — when generating agent context, also write `.review/diff-structure.json`: `{ baseRef, targetBranch, files }` serialized from the R1 model (the generator needs the parsed entries passed in — thread them through from where diff data already flows, keeping skillGenerator's no-`vscode` layer rule intact); add a short `AGENTS.md` section documenting the file and 1-based hunk addressing
- `src/activation/` or existing call site — pass the parsed `DiffFileEntry[]` to the generator

**Verify**:

- Run "Resolve with AI" (or the context-generation path directly): `.review/diff-structure.json` exists, is valid JSON, and its per-file hunk counts match the sidebar
- `AGENTS.md` references the file and explains `file + hunk index` addressing
- `.review/` remains gitignored — `git status` shows nothing new tracked
- `make dev` passes end-to-end
