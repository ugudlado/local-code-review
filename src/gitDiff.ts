import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface DiffLineStats {
  additions: number;
  deletions: number;
}

export interface LocalDiffResult {
  worktreePath: string;
  sourceBranch: string;
  targetBranch: string;
  /** The ref actually passed to `git diff` (target tip or resolved merge-base SHA). */
  baseRef: string;
  committedDiff: string;
  uncommittedDiff: string;
  allDiff: string;
  /** Per-path line stats from `git diff --numstat` (matches `git diff --stat`). */
  lineStats: Map<string, DiffLineStats>;
}

/**
 * Resolve the "base" ref used as the old side of the diff.
 *  - "merge-base": `git merge-base HEAD <target>` SHA — matches GitHub PR view,
 *    stable when the target branch advances past the branch point.
 *  - "target-tip": the target branch ref itself — matches `git diff <target>`.
 *
 * Falls back to the target ref if merge-base resolution fails (no common
 * ancestor, shallow clone, etc.).
 */
export async function resolveDiffBaseRef(
  workspaceRoot: string,
  targetBranch: string,
  mode: "merge-base" | "target-tip",
): Promise<string> {
  if (mode === "target-tip") return targetBranch;
  try {
    const sha = (
      await gitExec(["merge-base", "HEAD", targetBranch], workspaceRoot)
    ).trim();
    return sha || targetBranch;
  } catch {
    return targetBranch;
  }
}

/** Parse `git diff --numstat` output into a path → {additions, deletions} map. */
export function parseDiffNumstat(stdout: string): Map<string, DiffLineStats> {
  const stats = new Map<string, DiffLineStats>();
  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
    const deletions = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
    const path = parts.slice(2).join("\t");
    stats.set(path, { additions, deletions });
  }
  return stats;
}

async function gitExec(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    // git diff exits with code 1 when there ARE differences — that's normal
    const execErr = err as {
      stdout?: string;
      code?: number;
      stderr?: string;
    };
    if (execErr.code === 1 && execErr.stdout !== undefined) {
      return execErr.stdout;
    }
    throw new Error(
      `git ${args[0]} failed (exit ${execErr.code ?? "unknown"}): ${execErr.stderr ?? String(err)}`,
    );
  }
}

/**
 * Run git diff locally and return the same shape as the server's /api/diff endpoint.
 * Uses execFile (not exec) to avoid shell injection.
 *
 * Diff scope is controlled by `baseRef` (see `resolveDiffBaseRef`):
 *  - merge-base SHA → mirrors GitHub PR view (`git diff <merge-base>`),
 *    stable when the target branch advances past the branch point.
 *  - target tip ref → `git diff <target>`, surfaces reverse changes when the
 *    target advances.
 *
 * In both modes, untracked working-tree files are layered on top via synthetic
 * `new file mode` headers so about-to-be-committed work shows up in review.
 */
export async function getLocalDiff(
  workspaceRoot: string,
  targetBranch: string,
  baseRef: string,
): Promise<LocalDiffResult> {
  const sourceBranch = (
    await gitExec(["rev-parse", "--abbrev-ref", "HEAD"], workspaceRoot)
  ).trim();

  // Verify the target branch ref exists (we still surface a clear error against
  // the named branch even when the actual diff uses a merge-base SHA).
  try {
    await gitExec(["rev-parse", "--verify", targetBranch], workspaceRoot);
  } catch {
    throw new Error(`Target branch "${targetBranch}" not found`);
  }

  // Force standard a/b prefixes regardless of diff.mnemonicprefix config
  const prefixArgs = ["--src-prefix=a/", "--dst-prefix=b/"];

  // Branch commits only — three-dot against the target branch tip is always
  // the right semantic here regardless of diff base mode.
  const committedDiff = await gitExec(
    ["diff", ...prefixArgs, `${targetBranch}...HEAD`],
    workspaceRoot,
  );

  // Uncommitted diff: staged + unstaged vs HEAD
  const uncommittedDiff = await gitExec(
    ["diff", ...prefixArgs, "HEAD"],
    workspaceRoot,
  );

  // Full review scope: baseRef vs working tree
  const baseVsWorkingTree = await gitExec(
    ["diff", ...prefixArgs, baseRef],
    workspaceRoot,
  );

  // Untracked files: new files not yet git-added
  const untrackedRaw = await gitExec(
    ["ls-files", "--others", "--exclude-standard"],
    workspaceRoot,
  );
  const untrackedFiles = untrackedRaw
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);

  const untrackedDiff = untrackedFiles
    .map(
      (f) =>
        `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}`,
    )
    .join("\n");

  const allDiff = untrackedDiff
    ? `${baseVsWorkingTree}\n${untrackedDiff}`
    : baseVsWorkingTree;

  const lineStats = parseDiffNumstat(
    await gitExec(["diff", "--numstat", baseRef], workspaceRoot),
  );

  return {
    worktreePath: workspaceRoot,
    sourceBranch,
    targetBranch,
    baseRef,
    committedDiff,
    uncommittedDiff,
    allDiff,
    lineStats,
  };
}
