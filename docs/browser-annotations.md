# Browser Element Annotations

Leave review comments on a running dev page and have them land as Resolvr
threads, alongside your code-review comments, without leaving the browser.
Every surface writes the same `.review/sessions/<branch>-code.json` file, so
"Resolve with AI" treats UI feedback exactly like code feedback.

## Vite projects (recommended — zero setup after one line)

```bash
npm install -D @ugudlado1/resolvr
```

```ts
// vite.config.ts
import { resolvrAnnotations } from "@ugudlado1/resolvr/vite";
export default { plugins: [resolvrAnnotations()] };
```

The plugin runs inside the dev server, so it carries the session context
itself (repo + branch of the checkout it launched from), mounts the capture
endpoints at `/__resolvr/` on the dev server's own origin (no CORS, no
separate port, works with VS Code closed), and auto-injects the annotation
UI into every served page. Dev-server only — production builds are
untouched. Options: `resolvrAnnotations({ targetBranch: "develop" })`.

## Everything else (script tag or bookmarklet)

A localhost capture endpoint runs on `127.0.0.1:43117` whenever the VS Code
extension is active — or host it yourself with `resolvr serve` when VS Code
is closed. Then either:

- add a dev-only tag to your page: `<script src="http://127.0.0.1:43117/annotate.js"></script>`
  (no SRI hash on purpose: the script is served from your own loopback and
  changes with every resolvr version), or
- paste `assets/annotate.js` into the devtools console / wrap it in a
  `javascript:` bookmarklet.

The endpoint base is derived from the script tag's own `src`, so the same
script works against any host. Console-paste falls back to port 43117 —
edit the fallback in the script if you changed `resolvr.capturePort`.

## Using it

- Hover highlights elements; click one, type a comment, submit.
- The docked right-side panel lists the page's annotations with a
  `repo @ branch` header — so you always see which session you're writing
  into. Expand a thread for the full conversation (agent replies show as
  🤖 with the model name), reply, or resolve/reopen from the panel.
- The panel is a snapshot: it refreshes after your own actions or via the
  Refresh button, not live. If you switch branches while the dev server
  keeps running, a drift warning appears — the page may be showing stale
  code.
- In VS Code, these threads appear in the Threads sidebar under
  "UI Feedback"; clicking one opens the conversation in the same comment
  widget code-review threads use.

## Security model

- Endpoints bind to `127.0.0.1` only (or ride the Vite dev server).
- Cross-origin requests are allowed only from localhost origins (CORS +
  Origin check on POSTs).
- Every route rejects non-localhost `Host` headers, closing the DNS
  rebinding hole (a hostile domain re-resolving to 127.0.0.1 would
  otherwise read annotation data as "same-origin").
- Pages served over **https** cannot call an http localhost endpoint
  (mixed-content rules) — local http dev servers are the supported path.
