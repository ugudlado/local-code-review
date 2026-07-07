# Browser Element Annotations

Leave review comments on a running dev page and have them land as Resolvr
threads, alongside your code-review comments, without leaving the browser.

## Usage (zero-install)

1. Have VS Code open on your project with Resolvr active — it hosts the
   local capture endpoint on `127.0.0.1:43117` while running.
2. Open your dev server page (e.g. `http://localhost:5173`) in the browser.
3. Open devtools console, paste the contents of `assets/annotate.js`, press
   Enter.
4. Hover elements to see them highlighted; click one, type a comment, hit
   Submit.
5. The thread appears in Resolvr's Threads sidebar within a couple seconds,
   grouped under "UI Feedback".

Run `window.__resolvrAnnotate.stop()` in the console to turn off annotation
mode.

## Bookmarklet

For repeat use, wrap `assets/annotate.js`'s contents in a `javascript:` URL
and save it as a browser bookmark — e.g. prefix the minified script with
`javascript:` and paste the whole thing as the bookmark's URL. No build step,
no hosting required.

## Non-default port

If you've changed `resolvr.capturePort` in VS Code settings, edit the
`CAPTURE_PORT` constant at the top of `assets/annotate.js` (or the
bookmarklet) to match before using it — the port is baked into the script,
not auto-discovered.

## HTTPS dev servers

Browsers block a page served over `https://` from calling an `http://`
localhost endpoint (mixed-content / private-network-access rules). Local
`http://` dev servers are the supported path for this feature; there's no
workaround for `https` dev servers today.
