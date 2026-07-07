---
name: vscode-ext
description: Use when working on the VS Code extension — building, packaging, versioning, installing, type-checking, or developing extension features. Triggers when user mentions "vscode extension", "build extension", "package vsix", "extension version", "vsce", "extension development", or when modifying files under src/.
---

# VS Code Extension Development

Guide for developing, building, and packaging the resolvr VS Code extension.

## Extension Overview

- **Entry points** (all bundled by `pnpm build`):
  - `src/extension.ts` → `dist/extension.js` (the extension; `vscode` externalized)
  - `src/cli.ts` → `dist/cli.js` (resolvr CLI; `vscode` NOT externalized — a leaked import fails the build)
  - `src/vitePlugin.ts` → `dist/vite.js` (resolvr/vite plugin; same rule)
- **Bundler**: esbuild (CJS format)
- **Package manager**: pnpm (never npm)
- **Current version**: Check root `package.json` `version` field
- **Two artifacts**: `.vsix` via `pnpm package` (vsce, `.vscodeignore`), npm tarball via `pnpm pack` (`.npmignore` whitelist: dist/cli.js, dist/vite.js, assets/annotate.js). Never add a `files` property to package.json — vsce refuses it alongside `.vscodeignore`.

## Commands Reference

All commands run from the **repo root**:

| Task               | Command                                           |
| ------------------ | ------------------------------------------------- |
| Build              | `pnpm build`                                      |
| Watch (dev)        | `pnpm watch`                                      |
| Type-check         | `pnpm type-check`                                 |
| Package .vsix      | `pnpm package`                                    |
| Install in VS Code | `code --install-extension resolvr-<version>.vsix` |

## Build & Package Workflow

### Quick build

```bash
pnpm build
```

### Full package (build → .vsix)

```bash
pnpm build && pnpm package
```

### Build + package + install

```bash
pnpm build && pnpm package && \
code --install-extension resolvr-*.vsix
```

After installing, remind the user to reload VS Code (`Developer: Reload Window`).

## Versioning

### Full release versioning

Use `/release-prep` which bumps the version in `package.json`, builds the vsix, tags, and publishes.

## Architecture

```
├── src/
│   ├── extension.ts          # Extension entry point (activate/deactivate)
│   ├── sessionStore.ts       # File-based session CRUD operations
│   ├── sessionWatcher.ts     # FileSystemWatcher for .review/ changes
│   ├── changedFilesTree.ts   # TreeDataProvider for SCM sidebar
│   ├── threadsTree.ts        # TreeDataProvider for review threads
│   ├── diffPanelManager.ts   # Webview panel for diff rendering
│   ├── commentManager.ts     # VS Code CommentController integration
│   ├── agentInvoker.ts       # AI agent spawner for thread resolution
│   └── skillGenerator.ts     # Agent skill file generator
├── dist/
│   └── extension.js          # esbuild bundle output (gitignored)
├── package.json              # Extension manifest + contributes
├── tsconfig.json             # TypeScript config (noEmit, bundler resolution)
└── .vscodeignore             # Files excluded from .vsix package
```

### Key patterns

- **Serverless architecture**: Extension reads/writes session files directly (no HTTP server dependency)
- **File watchers**: `SessionWatcher` uses `vscode.workspace.createFileSystemWatcher` for live updates
- **TreeDataProvider**: `ChangedFilesProvider` and `ThreadsProvider` power the SCM sidebar views
- **CommentController**: Native VS Code comment API for inline thread annotations
- **esbuild bundling**: All dependencies bundled into single CJS file; only `vscode` is external

## Gotchas

- **Always use pnpm**: Never npm. All commands go through pnpm.
- **`--no-dependencies` for vsce**: Required because dependencies are bundled by esbuild, not shipped in `node_modules`.
- **dist/ is gitignored**: Always build before packaging.
- **esbuild doesn't type-check**: Run `pnpm type-check` separately — the build step skips type checking.
- **Reload after install**: VS Code requires window reload (`Developer: Reload Window`) to pick up extension changes.
- **`.vscodeignore` matters**: Controls what goes into the `.vsix`. Source files (`src/`), `node_modules/`, and `tsconfig.json` are excluded.
- **`vscode` module is external**: Never bundle the `vscode` module — it's provided by the VS Code runtime. esbuild config uses `--external:vscode`.

## Validation Checklist

Before packaging a release:

1. `pnpm type-check` — passes with no errors
2. `pnpm build` — produces `dist/extension.js`
3. Version in `package.json` matches intended release
4. `pnpm package` — produces `.vsix`
5. Test install: `code --install-extension <path>.vsix` → reload → verify activation
