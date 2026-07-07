/**
 * Lightweight diff parser.
 * Extracts file paths, statuses, and per-file diff stats from unified diff output.
 */

export enum DiffStatus {
  Added = "A",
  Modified = "M",
  Deleted = "D",
  Renamed = "R",
}

export interface DiffHunk {
  index: number; // 1-based within the file
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string; // git's function-context text after the closing @@, may be ""
  additions: number;
  deletions: number;
  firstChangedNewLine: number; // new-side line of the first +/- line — the jump target
  preview: string; // first changed line's content, trimmed, max ~80 chars
}

export interface DiffFileEntry {
  path: string; // display path (new path for renames)
  oldPath: string; // path in base ref
  newPath: string; // path in HEAD / working tree
  status: DiffStatus;
  additions: number; // lines added (from hunk content)
  deletions: number; // lines removed (from hunk content)
  hunks: DiffHunk[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parseHunks(lines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let newLineCounter = 0;

  for (const line of lines) {
    const headerMatch = line.match(HUNK_HEADER_RE);
    if (headerMatch) {
      const oldStart = Number(headerMatch[1]);
      const newStart = Number(headerMatch[3]);
      current = {
        index: hunks.length + 1,
        oldStart,
        oldCount: headerMatch[2] !== undefined ? Number(headerMatch[2]) : 1,
        newStart,
        newCount: headerMatch[4] !== undefined ? Number(headerMatch[4]) : 1,
        section: headerMatch[5].trim(),
        additions: 0,
        deletions: 0,
        firstChangedNewLine: newStart,
        preview: "",
      };
      hunks.push(current);
      newLineCounter = newStart;
      continue;
    }
    if (!current) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions++;
      if (current.preview === "") {
        current.firstChangedNewLine = newLineCounter;
        current.preview = line.slice(1).trim().slice(0, 80);
      }
      newLineCounter++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions++;
      if (current.preview === "") {
        current.firstChangedNewLine = newLineCounter;
        current.preview = line.slice(1).trim().slice(0, 80);
      }
    } else if (line.startsWith(" ")) {
      newLineCounter++;
    }
  }

  return hunks;
}

/** Apply `git diff --numstat` counts so tree stats match `git diff --stat`. */
export function applyLineStats(
  entries: DiffFileEntry[],
  lineStats: Map<string, { additions: number; deletions: number }>,
): void {
  for (const entry of entries) {
    const stats =
      lineStats.get(entry.path) ??
      lineStats.get(entry.newPath) ??
      lineStats.get(entry.oldPath);
    if (stats) {
      entry.additions = stats.additions;
      entry.deletions = stats.deletions;
    }
  }
}

export function parseDiffFileList(unifiedDiff: string): DiffFileEntry[] {
  if (!unifiedDiff.trim()) return [];

  const blocks = unifiedDiff.split(/^diff --git /m).slice(1);
  const entries: DiffFileEntry[] = [];

  for (const block of blocks) {
    // Parse "a/<old> b/<new>" — non-greedy first group so paths with " b/" work
    const headerMatch = block.match(/^a\/(.+?) b\/(.+)$/m);
    if (!headerMatch) continue;

    const oldPath = headerMatch[1];
    const newPath = headerMatch[2];

    let status: DiffStatus = DiffStatus.Modified;
    if (/^new file mode/m.test(block)) {
      status = DiffStatus.Added;
    } else if (/^deleted file mode/m.test(block)) {
      status = DiffStatus.Deleted;
    } else if (/^rename from /m.test(block)) {
      status = DiffStatus.Renamed;
    }

    // Count insertions/deletions from hunk content lines
    let additions = 0;
    let deletions = 0;
    const lines = block.split("\n");
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }

    const path = status === DiffStatus.Deleted ? oldPath : newPath;
    entries.push({
      path,
      oldPath,
      newPath,
      status,
      additions,
      deletions,
      hunks: parseHunks(lines),
    });
  }

  // Prefer the entry with real hunks when paths collide (e.g. untracked synthetic header)
  const byPath = new Map<string, DiffFileEntry>();
  for (const entry of entries) {
    const prev = byPath.get(entry.path);
    if (
      !prev ||
      entry.additions + entry.deletions > prev.additions + prev.deletions
    ) {
      byPath.set(entry.path, entry);
    }
  }
  return [...byPath.values()];
}
