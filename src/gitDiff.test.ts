import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseDiffNumstat, resolveDiffBaseRef } from "./gitDiff";

describe("parseDiffNumstat", () => {
  it("returns an empty map for empty input", () => {
    expect(parseDiffNumstat("")).toEqual(new Map());
    expect(parseDiffNumstat("\n\n")).toEqual(new Map());
  });

  it("parses well-formed text-file lines", () => {
    const stdout = ["3\t4\tsrc/a.ts", "10\t0\tsrc/b.ts"].join("\n");
    const stats = parseDiffNumstat(stdout);
    expect(stats.get("src/a.ts")).toEqual({ additions: 3, deletions: 4 });
    expect(stats.get("src/b.ts")).toEqual({ additions: 10, deletions: 0 });
  });

  it("treats '-' (binary marker) as zero", () => {
    const stdout = "-\t-\timage.png";
    const stats = parseDiffNumstat(stdout);
    expect(stats.get("image.png")).toEqual({ additions: 0, deletions: 0 });
  });

  it("preserves tab characters that appear in paths", () => {
    const stdout = "1\t2\tweird\tname.ts";
    const stats = parseDiffNumstat(stdout);
    expect(stats.get("weird\tname.ts")).toEqual({ additions: 1, deletions: 2 });
  });

  it("skips malformed lines without throwing", () => {
    const stdout = ["1\t2", "ok", "3\t4\tfile.ts"].join("\n");
    const stats = parseDiffNumstat(stdout);
    expect(stats.size).toBe(1);
    expect(stats.get("file.ts")).toEqual({ additions: 3, deletions: 4 });
  });
});

describe("resolveDiffBaseRef", () => {
  let repo: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "resolvr-gitdiff-"));
    const run = (args: string[]) =>
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    run(["commit", "--allow-empty", "-m", "base"]);
    run(["checkout", "-q", "-b", "feature"]);
    run(["commit", "--allow-empty", "-m", "feature-1"]);
    // Advance main past the branch point to make merge-base vs target-tip distinct.
    run(["checkout", "-q", "main"]);
    run(["commit", "--allow-empty", "-m", "main-2"]);
    run(["checkout", "-q", "feature"]);
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("returns the target branch verbatim in target-tip mode", async () => {
    expect(await resolveDiffBaseRef(repo, "main", "target-tip")).toBe("main");
  });

  it("returns the merge-base SHA in merge-base mode", async () => {
    const sha = await resolveDiffBaseRef(repo, "main", "merge-base");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const expected = execFileSync("git", ["merge-base", "HEAD", "main"], {
      cwd: repo,
      encoding: "utf-8",
    }).trim();
    expect(sha).toBe(expected);
  });

  it("falls back to the target branch when merge-base resolution fails", async () => {
    // No common ancestor with a nonexistent ref → should fall back gracefully.
    expect(await resolveDiffBaseRef(repo, "nonexistent", "merge-base")).toBe(
      "nonexistent",
    );
  });
});
