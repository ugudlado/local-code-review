# Specification: Hunk-Based Diff Navigation

## Motivation

Resolvr's review unit today is the **file**: the Changed Files tree lists files, clicking one opens VS Code's native diff editor for the whole file, and the reviewer scrolls. For small diffs that's fine. For agent-generated changesets — many files, each with a handful of scattered changes — the reviewer's real unit of attention is the **hunk**, and Resolvr gives them no way to see, count, or jump between hunks. There is no "next change" flow; reviewing 20 files means 20 clicks and 20 manual scrolls.

[Hunk](https://github.com/modem-dev/hunk/) (modem-dev's terminal diff viewer, built for reviewing agent-authored changesets) demonstrates the model worth adopting: hunks are **first-class, 1-based addressable units** (`--file src/App.tsx --hunk 2`), review is a **continuous stream** across files rather than per-file tabs, and the diff structure is exposed to agents as **machine-readable data** (`hunk session review --json`, batch comments targeting `hunkNumber`/`newLine`) instead of raw patch text.

Resolvr already has the raw material: `DiffPanelManager.populate()` (`src/diffPanelManager.ts:129`) holds the full unified diff text in memory, and `parseDiffFileList()` (`src/diffParser.ts:39`) already walks every hunk line — it just discards everything except +/− counts (`src/diffParser.ts:62–69`). Parsing hunks is an additive change to a pure, vitest-tested Logic-layer module. Rendering them is an additive node kind in the existing tree.

## Why not adopt hunk itself

Hunk is a standalone terminal TUI built on OpenTUI. Resolvr is a VS Code extension whose diff rendering is VS Code's native diff editor — syntax highlighting, split/inline layouts, themes, and word-level diffing come for free and are better than anything we'd embed. Shelling out to a TUI from a VS Code review flow would fork the UX in two. What's worth taking is hunk's **review model** (addressable hunks, stream navigation, agent-readable structure), not its rendering. No dependency on hunk is added.

## Requirements

### R1: Parse hunks in `diffParser.ts`

Extend the Logic-layer parser to retain per-file hunk structure:

```ts
export interface DiffHunk {
  index: number; // 1-based within the file (hunk's addressing model)
  oldStart: number; // from the @@ header (includes leading context lines)
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string; // text after the closing @@ (git's function context), may be ""
  additions: number; // changed-line counts for this hunk only
  deletions: number;
  firstChangedNewLine: number; // new-side line of the first +/− line — the jump target
  preview: string; // first changed line's content, trimmed, max ~80 chars
}
```

`DiffFileEntry` gains `hunks: DiffHunk[]`. Parsing happens in the same block walk `parseDiffFileList` already does — one pass, no second parse of the diff text.

Details that matter for correctness:

- `oldStart`/`newStart` point at the first **context** line of the hunk (git default `-U3`), not the first change. The jump target is `firstChangedNewLine`, computed by walking the hunk body: track the new-side line counter (` ` and `+` lines increment it) and record it at the first `+` or `-` line. For a pure deletion (`-` lines only at that point), the new-side counter value at that spot is still the correct place to land the cursor.
- Deleted files, binary files, and mode-only changes have zero hunks — `hunks: []`, never a parse error.
- `@@ -a +c @@` (count omitted when 1) must parse: count defaults to 1.

### R2: Hunks as tree children in Changed Files

- `src/fileTree.ts` (Logic): new node kind `{ kind: "hunk"; file: DiffFileItem; hunk: DiffHunk }`. File nodes with ≥1 hunk become collapsible (collapsed by default), children are their hunks in order.
- `src/changedFilesTree.ts` (UI): render a hunk node as `@@ <newStart> <section-or-preview>` with a `+x −y` description. Applies in both `flat` and `compact-tree` modes — hunk children hang off file nodes identically in either.
- Selecting a hunk node opens the same diff editor `openFile()` already opens (`src/diffPanelManager.ts:179`), passing `{ selection: Range(firstChangedNewLine - 1, 0, ...) }` in the `TextDocumentShowOptions` of the `vscode.diff` command so the editor reveals that hunk. For **deleted** files (no new side), open without a selection — whole-file view is acceptable; do not try to address the base-side virtual document in this iteration.

### R3: Review-stream navigation across files

Two commands, contributed in `package.json` and registered in `src/activation/commands.ts`:

- `resolvr.nextHunk` / `resolvr.prevHunk` — move to the next/previous hunk in the flat ordered list of (file, hunk) pairs across **all** changed files, wrapping at the ends. Crossing a file boundary opens the next file's diff editor (same path as R2).
- Current position derives from the active editor: match the active diff editor's document against `_files` (via the existing `getFileByPath`, `src/diffPanelManager.ts:46`), find the cursor line, and locate the nearest hunk after/before it. No active diff editor → go to the first/last hunk of the first/last file.
- Default keybindings `alt+j` / `alt+k` gated on `when: resolvr.hasDiffPanel` (context key already maintained, `src/diffPanelManager.ts:136–140`). Users can rebind; conflicts with other extensions are their standard VS Code problem, not ours to solve.

### R4: Expose hunk structure to agents

The counterpart of hunk's `review --json`: agents reading `.review/AGENTS.md` today get thread data but no diff structure — they re-run `git diff` and burn context on raw patch text.

- `src/skillGenerator.ts` additionally writes `.review/diff-structure.json` when generating agent context: `{ baseRef, targetBranch, files: [{ path, status, additions, deletions, hunks: [...] }] }` — exactly the parsed model from R1, serialized as-is.
- `AGENTS.md` gains a short section pointing at the file and explaining hunk addressing ("file + 1-based hunk index"), so an agent can say "hunk 2 of `src/App.tsx`" and map it to lines without parsing a patch.
- This is generated data derived from the working tree — same lifecycle and gitignore status as the rest of `.review/`.

## Non-Functional Requirements

### NF1: No new dependencies, no second diff run

Hunk parsing reuses the diff text `populate()` already fetched. No extra `git diff` subprocess, no diff library. Everything in R1 is vanilla string walking in the existing parser.

### NF2: Layer discipline

`DiffHunk` parsing and the (file, hunk) ordering/navigation math live in the Logic layer (`diffParser.ts`, `fileTree.ts` or a small pure helper) with vitest coverage and no `vscode` import. Only the tree rendering, editor-revealing, and command registration touch `vscode`.

### NF3: Performance

Parsing hunks adds one field-extraction to a loop that already visits every diff line — no measurable cost. Tree rendering stays lazy: hunk children are computed per file node on expansion, and a 500-hunk changeset must not lag the sidebar (hunk arrays are already in memory; `getChildren` is a map, not a parse).

## Opportunities from hunk's model — adopted, deferred, or rejected

The user-facing point of this spec is navigation (R1–R3) plus agent-readable structure (R4). The rest of hunk's feature set, triaged:

| Hunk feature                                     | Verdict        | Why                                                                                                                                                                                                                              |
| ------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-based addressable hunks                        | **Adopt (R1)** | Foundation for everything else                                                                                                                                                                                                   |
| Review stream across files                       | **Adopt (R3)** | The actual pain point in agent-changeset review                                                                                                                                                                                  |
| `review --json` for agents                       | **Adopt (R4)** | Cheap; skillGenerator already owns agent context                                                                                                                                                                                 |
| Batch agent comments by `hunkNumber`             | **Defer**      | Agents already write `diff-line` anchors directly per `AGENTS.md` instructions; hunk-number addressing is a convenience layer — add to `AGENTS.md` docs once R4 data exists and agents demonstrably fumble line/hash computation |
| Per-hunk open-thread badges in the tree          | **Defer**      | `updateThreadCounts` (`src/diffPanelManager.ts:264`) does this per file; mapping thread `anchor.line` into hunk ranges is easy once R1 lands, but it's polish, not navigation                                                    |
| Watch mode (auto-reload on working-tree change)  | **Defer**      | Real improvement, separate concern: a debounced `FileSystemWatcher`-driven `refresh()` deserves its own small spec — it touches lifecycle, not diff parsing                                                                      |
| Split/stack layouts, themes, syntax highlighting | **Reject**     | VS Code's native diff editor already does all of it better                                                                                                                                                                       |
| Live session daemon (`hunk session ...`)         | **Reject**     | Resolvr is serverless by design (see browser-annotations spec, NF1); the session-file watcher is our steering channel                                                                                                            |
| Structural/semantic diffing                      | **Reject**     | Hunk itself doesn't do it (uses line-based Pierre diffs); out of scope here too                                                                                                                                                  |

## User Stories

### US1: Reviewing an agent's 15-file changeset

A developer asks an agent to rename a concept across the codebase. The Changed Files tree shows 15 files; expanding one shows its 3 hunks with function-context labels. The developer clicks the first hunk, reviews, hits `alt+j` repeatedly — Resolvr walks them through every hunk in every file in order, opening diff editors as it crosses file boundaries. No scrolling, no hunting.

### US2: Agent orients itself without re-diffing

An agent invoked via "Resolve with AI" needs to know what changed near a thread. Instead of running `git diff` and parsing a patch, it reads `.review/diff-structure.json`, sees `src/gitDiff.ts` has hunk 2 at new-line 47 touching `parseDiffNumstat`, and reads just that region of the file.

## Out of Scope

- **Per-hunk review states** (viewed/approved per hunk) — hunk itself doesn't have them; revisit only with real demand.
- **Hunk-anchored threads** — threads stay `diff-line`-anchored (and `dom-element`, per the browser-annotations spec); hunks are navigation, not a third anchor type.
- **Staging/unstaging hunks** — Resolvr reviews, it doesn't stage; VS Code's SCM view already does this.
- **Base-side (deleted file) hunk reveal** — deleted files open unpositioned.

## Success Criteria

1. Expanding a changed file in the sidebar lists its hunks with line numbers, section context, and +/− counts; clicking one opens the diff editor revealed at that hunk.
2. `alt+j`/`alt+k` (or the commands directly) walk every hunk of every changed file in order, crossing file boundaries and wrapping.
3. `.review/diff-structure.json` exists after agent-context generation and matches the sidebar's file/hunk structure exactly.
4. `make test` covers hunk parsing (including omitted-count headers, pure deletions, renamed files, zero-hunk binary/deleted entries) and next/prev ordering math, with no `vscode` mocks.
5. No new npm dependencies; no additional `git diff` invocations per populate.
