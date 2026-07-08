# Beyond the editor

The same review session is reachable from your browser and terminal — every surface writes the same session file.

## Browser annotations

Click elements in your running app to file UI feedback that lands in the _Threads_ view under **UI Feedback**.

- **Vite**: `npm i -D @ugudlado1/resolvr`, then add `resolvrAnnotations()` to your plugins — done
- **Anything else**: run **Resolvr: Copy Browser Annotation Snippet** and paste the script tag into your dev page

## CLI

```bash
npx @ugudlado1/resolvr comment src/app.ts:42 "extract this into a helper"
```

`resolvr serve` hosts the annotation endpoint when VS Code isn't running. See `docs/browser-annotations.md` for the full guide.
