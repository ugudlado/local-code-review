import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Provides old-side file content for diff editors via a virtual document scheme.
 * URI format: resolvr-base:/<relative-path>
 *
 * The "base ref" is whatever the diff tree is diffing against — either the
 * target branch tip or the merge-base SHA — resolved by the caller via
 * `resolveDiffBaseRef`. Keeping the resolution in one place (DiffPanelManager)
 * ensures the file list and the base content always agree; an earlier bug
 * where the tree used `main` while base content used merge-base showed up as
 * empty diff tabs for files that appeared in the tree.
 */
export class BaseContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private _cache = new Map<string, string>();
  private _workspaceRoot: string;
  private _baseRef: string;

  constructor(workspaceRoot: string, baseRef: string = "main") {
    this._workspaceRoot = workspaceRoot;
    this._baseRef = baseRef;
  }

  setBaseRef(ref: string): void {
    if (this._baseRef === ref) return;
    this._baseRef = ref;
    this.invalidate();
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const relativePath = uri.path.startsWith("/")
      ? uri.path.slice(1)
      : uri.path;

    const cached = this._cache.get(relativePath);
    if (cached !== undefined) return cached;

    try {
      const { stdout } = await execFileAsync(
        "git",
        ["show", `${this._baseRef}:${relativePath}`],
        { cwd: this._workspaceRoot, maxBuffer: 10 * 1024 * 1024 },
      );
      this._cache.set(relativePath, stdout);
      return stdout;
    } catch {
      // File doesn't exist at ref (new file) — return empty
      this._cache.set(relativePath, "");
      return "";
    }
  }

  private _buildUri(key: string): vscode.Uri {
    return vscode.Uri.parse(`${SCHEME_BASE}:/${key}`);
  }

  invalidate(path?: string): void {
    if (path) {
      const key = path.startsWith("/") ? path.slice(1) : path;
      if (this._cache.delete(key)) {
        this._onDidChange.fire(this._buildUri(key));
      }
    } else {
      const keys = [...this._cache.keys()];
      this._cache.clear();
      for (const key of keys) {
        this._onDidChange.fire(this._buildUri(key));
      }
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/**
 * Trivial content provider that always returns empty string.
 * Used for the new-side URI of deleted files.
 */
export class EmptyContentProvider
  implements vscode.TextDocumentContentProvider
{
  provideTextDocumentContent(): string {
    return "";
  }
}

export const SCHEME_BASE = "resolvr-base";
export const SCHEME_EMPTY = "resolvr-empty";
