# Resolvr

Code review inside VS Code. Open diffs, leave threaded comments on any line, then hand the open threads to your AI agent to work through. Session files live on your machine. No account needed, no server to run.

![Resolvr demo — changed files tree, inline review comments, and AI thread resolution](assets/demo.gif)

## Features

- Threaded inline comments on any line, using VS Code's native Comments API
- Changed files tree in the Source Control sidebar with diff stats and per-file hunks — click a hunk to jump to it, or walk every hunk across all files with `alt+j`/`alt+k`
- Side-by-side diff panel
- Live updates as session files change on disk
- "Resolve with AI": spawns your configured agent in a terminal to tackle open threads
- Browser element annotations: click any element on your locally running dev page, leave a comment, and it becomes a review thread the agent works through like any other
- `resolvr` CLI (`comment`, `serve`) for filing feedback from the terminal and hosting the annotation endpoint without VS Code
- `resolvr/vite` plugin: one line in `vite.config.ts` adds the whole annotation surface to your dev server

## Install

From the VS Code Marketplace:

```bash
code --install-extension ugudlado.resolvr
```

Or grab the `.vsix` from the [latest release](https://github.com/ugudlado/resolvr/releases):

```bash
code --install-extension resolvr-<version>.vsix
```

## How it works

Open changed files in the sidebar and comment on any line. Threads stay open until resolved. Reply, reopen, or mark as won't fix. When you're ready, hit "Resolve with AI" and your agent picks up the open threads inline.

Sessions are stored in `.review/sessions/` as JSON files you can diff, commit, or ignore. Every capture surface — VS Code comments, terminal, browser — writes the same files, so the agent flow is identical regardless of where feedback came from.

## Browser annotations

For Vite projects, add the plugin and you're done — the annotation panel appears on every dev page:

```bash
npm install -D @ugudlado1/resolvr
```

```ts
// vite.config.ts
import { resolvrAnnotations } from "@ugudlado1/resolvr/vite";
export default { plugins: [resolvrAnnotations()] };
```

For everything else, the extension (or `resolvr serve`) hosts a localhost capture endpoint; add a dev-only script tag or use the bookmarklet:

```html
<script src="http://127.0.0.1:43117/annotate.js"></script>
```

Click an element, type a comment, submit — the thread shows up in VS Code's Threads sidebar under "UI Feedback", and the docked page panel shows conversations, replies, and resolve/reopen. See [docs/browser-annotations.md](docs/browser-annotations.md).

## CLI

```bash
resolvr comment src/gitDiff.ts:52 "this swallows the rename case"
resolvr serve          # host the annotation endpoint with VS Code closed
```

Distributed with the repo (`pnpm link` or install the packed tarball); session identity is the checkout you run it from.

## Development

```bash
git clone https://github.com/ugudlado/resolvr.git
cd resolvr
pnpm install
```

```bash
pnpm build       # bundle the extension
pnpm watch       # watch mode
pnpm type-check  # type check
pnpm format      # prettier
```

### Packaging

```bash
pnpm package
```

### Debug in VS Code

Press `F5` to launch the Extension Development Host.

## Contributing

1. Fork and create a feature branch
2. `pnpm install`
3. Make changes, run `pnpm type-check`
4. `pnpm build`
5. Open a pull request

## License

MIT. See [LICENSE](./LICENSE).
