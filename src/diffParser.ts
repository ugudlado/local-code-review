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

export interface DiffFileEntry {
  path: string; // display path (new path for renames)
  oldPath: string; // path in base ref
  newPath: string; // path in HEAD / working tree
  status: DiffStatus;
  additions: number; // lines added (from hunk content)
  deletions: number; // lines removed (from hunk content)
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
