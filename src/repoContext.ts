import { execFileSync } from "child_process";

// ---------------------------------------------------------------------------
// Synchronous git context helpers shared by the non-extension hosts (CLI and
// Vite plugin). Sync is fine here: calls happen on user actions (a CLI
// invocation, a capture POST, a panel refresh), not in any hot path.
// No `vscode` import — these bundle into vscode-free entry points.
// ---------------------------------------------------------------------------

/** Branch of the checkout at `cwd`, or null when detached / not a repo. */
export function currentBranchSync(cwd: string): string | null {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf-8",
    }).trim();
    return branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

/** Repo toplevel for `cwd`, or null when not inside a git repository. */
export function repoRootSync(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

/** Branch-derived session key — mirrors branchDetector.commentSessionId. */
export function toSessionId(branch: string): string {
  return branch.replace(/\//g, "--");
}

/** Explicit override wins; else main if it exists, else master, else main. */
export function detectTargetBranch(
  workspaceRoot: string,
  override?: string,
): string {
  if (override) return override;
  for (const candidate of ["main", "master"]) {
    try {
      execFileSync(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
        { cwd: workspaceRoot },
      );
      return candidate;
    } catch {
      // ref missing — try the next candidate
    }
  }
  return "main";
}
