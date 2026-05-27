import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around `git` subprocess invocations. Centralizes the
 * `execFile` boilerplate, normalizes the "exit 1 with output" case
 * (which `git diff` uses to signal "there are differences"), and gives
 * the rest of the codebase a single seam to mock if we ever need to.
 *
 * Pure-ish IO layer — no `vscode`, no business logic.
 */
export async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    // `git diff` exits with code 1 when there ARE differences. That's normal.
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

/** Run `git rev-parse <...args>` and return the trimmed stdout. */
export async function gitRevParse(
  cwd: string,
  ...args: string[]
): Promise<string> {
  return (await git(["rev-parse", ...args], cwd)).trim();
}

/** List branches via the `git branch -a` CLI. */
export async function listBranchesViaCli(cwd: string): Promise<string[]> {
  try {
    const stdout = await git(["branch", "-a"], cwd);
    return stdout
      .split("\n")
      .map((l) => l.replace(/^\*?\s+/, "").trim())
      .filter((l) => l.length > 0 && !l.includes("->"));
  } catch {
    return [];
  }
}
