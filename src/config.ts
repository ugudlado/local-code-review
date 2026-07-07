import * as vscode from "vscode";

export function getDefaultTargetBranch(): string {
  return vscode.workspace
    .getConfiguration("resolvr")
    .get<string>("defaultTargetBranch", "main");
}

export type DiffBaseMode = "merge-base" | "target-tip";

export function getConfiguredDiffBaseMode(): DiffBaseMode {
  const value = vscode.workspace
    .getConfiguration("resolvr")
    .get<string>("diffBase", "merge-base");
  return value === "target-tip" ? "target-tip" : "merge-base";
}

export function getCapturePort(): number {
  return vscode.workspace
    .getConfiguration("resolvr")
    .get<number>("capturePort", 43117);
}
