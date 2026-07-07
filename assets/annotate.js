/**
 * Resolvr browser annotation capture script.
 *
 * Load on a locally running dev page — easiest as a one-line dev-only tag,
 * since the capture server serves this file itself:
 *   <script src="http://127.0.0.1:43117/annotate.js"></script>
 * (Paste into the devtools console or a bookmarklet works too. No SRI hash on
 * the tag: the script is served from your own loopback and changes with every
 * resolvr version — integrity pinning would break on each update and defends
 * against nothing here.)
 * Click any element, type a comment, and it's saved as a review thread
 * Resolvr picks up in VS Code — no build step, no dependency beyond the
 * DOM/fetch APIs already in the browser.
 *
 * Also shows a docked right-side panel listing existing annotations for the
 * current page (fetched on inject) — click one to expand its full
 * conversation. This is a snapshot: it does not live-poll for VS Code-side
 * replies. Re-run the script to refresh.
 *
 * Endpoint discovery is automatic when loaded via a script tag (the base URL
 * is derived from the tag's src) — Vite-plugin and standalone hosts both work
 * untouched. Only console-paste uses the hardcoded fallback below; edit it if
 * you changed `resolvr.capturePort`.
 */
(function () {
  // Endpoint base comes from this script's own src: the Vite plugin serves it
  // at /__resolvr/annotate.js (same-origin middleware), the standalone capture
  // server at :43117/annotate.js. Console paste / bookmarklet eval has no
  // currentScript — falls back to the standalone default.
  const ownScript = document.currentScript;
  const BASE_URL =
    ownScript && ownScript.src
      ? ownScript.src.replace(/\/annotate\.js(\?.*)?$/, "")
      : "http://127.0.0.1:43117";
  const CAPTURE_URL = `${BASE_URL}/annotate`;
  const ANNOTATIONS_URL = `${BASE_URL}/annotations`;

  if (window.__resolvrAnnotate) {
    window.__resolvrAnnotate.stop();
  }

  const HIGHLIGHT_STYLE = "outline: 2px solid #f43f5e; outline-offset: -2px; cursor: crosshair;";
  const THREAD_HIGHLIGHT_STYLE = "outline: 2px solid #8b5cf6; outline-offset: -2px;";
  let hovered = null;
  let threadHighlighted = null;

  function setHighlight(el) {
    if (hovered === el) return;
    if (hovered) hovered.style.cssText = hovered.__resolvrOrigStyle || "";
    hovered = el;
    if (hovered) {
      hovered.__resolvrOrigStyle = hovered.style.cssText;
      hovered.style.cssText += HIGHLIGHT_STYLE;
    }
  }

  function setThreadHighlight(el) {
    if (threadHighlighted === el) return;
    if (threadHighlighted) {
      threadHighlighted.style.cssText = threadHighlighted.__resolvrThreadOrigStyle || "";
    }
    threadHighlighted = el;
    if (threadHighlighted) {
      threadHighlighted.__resolvrThreadOrigStyle = threadHighlighted.style.cssText;
      threadHighlighted.style.cssText += THREAD_HIGHLIGHT_STYLE;
      threadHighlighted.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  /** Compute a selector stable enough to identify this element on reload: tag + id, or tag + classes + nth-of-type disambiguation among siblings sharing the same selector. */
  function computeSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;

    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList).map((c) => CSS.escape(c));
    let selector = classes.length ? `${tag}.${classes.join(".")}` : tag;

    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((sib) =>
        sib.matches(selector),
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(el) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }
    return selector;
  }

  function computeLabel(el) {
    const text = (el.textContent || "").trim().slice(0, 60);
    return text ? `${el.tagName.toLowerCase()} — ${text}` : el.tagName.toLowerCase();
  }

  // The one open comment box — clicks inside it must not spawn another.
  let commentBox = null;

  function closeCommentBox() {
    if (commentBox) commentBox.remove();
    commentBox = null;
  }

  function showCommentBox(el, x, y) {
    closeCommentBox();
    const box = document.createElement("div");
    commentBox = box;
    box.style.cssText = `
      position: fixed; top: ${y}px; left: ${x}px; z-index: 2147483647;
      background: #1e1e1e; color: #fff; padding: 8px; border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4); font-family: sans-serif; font-size: 13px;
    `;
    box.innerHTML = `
      <textarea placeholder="What's wrong here?" rows="3" style="width: 240px; box-sizing: border-box; margin-bottom: 6px;"></textarea>
      <br>
      <button data-action="submit">Submit</button>
      <button data-action="cancel">Cancel</button>
      <span data-role="status" style="margin-left: 6px;"></span>
    `;
    document.body.appendChild(box);

    const textarea = box.querySelector("textarea");
    const status = box.querySelector('[data-role="status"]');
    textarea.focus();

    box.querySelector('[data-action="cancel"]').onclick = closeCommentBox;
    box.querySelector('[data-action="submit"]').onclick = async () => {
      const comment = textarea.value.trim();
      if (!comment) return;

      status.textContent = "Sending…";
      try {
        const res = await fetch(CAPTURE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: window.location.href,
            selector: computeSelector(el),
            label: computeLabel(el),
            comment,
            viewport: { width: window.innerWidth, height: window.innerHeight },
          }),
        });
        if (res.ok) {
          status.textContent = "Saved ✓";
          setTimeout(closeCommentBox, 800);
          loadPanel();
        } else {
          const body = await res.json().catch(() => ({}));
          status.textContent = `Error: ${body.error || res.status}`;
        }
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    };
  }

  /** True for clicks/hovers on our own UI (panel or comment box) — never treat those as page-element interactions. */
  function isOwnUi(target) {
    return (
      (panel && panel.contains(target)) ||
      (commentBox && commentBox.contains(target))
    );
  }

  function onMouseOver(e) {
    if (isOwnUi(e.target)) {
      setHighlight(null);
      return;
    }
    setHighlight(e.target);
  }

  function onClick(e) {
    if (isOwnUi(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    showCommentBox(e.target, e.clientX, e.clientY);
  }

  // -------------------------------------------------------------------------
  // Right-docked panel: lists annotations for this page, expands on click.
  // -------------------------------------------------------------------------

  let panel = null;
  let panelListEl = null;

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "resolvr-panel";
    panel.style.cssText = `
      position: fixed; top: 0; right: 0; bottom: 0; width: 320px; z-index: 2147483646;
      background: #1e1e1e; color: #ddd; font-family: sans-serif; font-size: 13px;
      box-shadow: -2px 0 12px rgba(0,0,0,0.4); overflow-y: auto; padding: 12px;
      box-sizing: border-box;
    `;
    panel.innerHTML = `
      <div style="font-weight: 600; display: flex; justify-content: space-between; align-items: center;">
        <span>Resolvr — UI Feedback</span>
        <button data-action="refresh" style="font-size: 11px;">Refresh</button>
      </div>
      <div data-role="context" style="font-size: 11px; opacity: 0.7; margin: 2px 0 8px;"></div>
      <div data-role="drift" style="display: none; font-size: 11px; background: #4d2b00; color: #ffb86c; border-radius: 3px; padding: 4px 6px; margin-bottom: 8px;"></div>
      <div data-role="list"></div>
    `;
    document.body.appendChild(panel);
    panelListEl = panel.querySelector('[data-role="list"]');
    panel.querySelector('[data-action="refresh"]').onclick = loadPanel;
  }

  /** Header: which repo @ branch annotations land in, plus a branch-drift warning. */
  async function loadContext() {
    const contextEl = panel.querySelector('[data-role="context"]');
    const driftEl = panel.querySelector('[data-role="drift"]');
    try {
      const ctx = await fetch(`${BASE_URL}/context`).then((r) => r.json());
      contextEl.textContent = `${ctx.workspaceName} @ ${ctx.branch ?? "no branch"}`;
      contextEl.title = ctx.workspaceRoot;
      if (ctx.launchBranch && ctx.branch && ctx.launchBranch !== ctx.branch) {
        driftEl.style.display = "block";
        driftEl.textContent = `⚠ UI was started on "${ctx.launchBranch}" but the repo is now on "${ctx.branch}" — this page may be showing stale code.`;
      } else {
        driftEl.style.display = "none";
      }
    } catch {
      contextEl.textContent = "context unavailable";
    }
  }

  // Thread id whose conversation is expanded — survives re-renders so the
  // panel stays open across reply/resolve/refresh.
  let expandedId = null;

  function formatTime(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }

  function renderMessages(a) {
    return a.messages
      .map(
        (m) => `
      <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid #333;">
        <div style="display: flex; justify-content: space-between; font-size: 11px;">
          <strong>${m.authorType === "agent" ? "🤖 " : ""}${escapeHtml(m.author)}</strong>
          <span style="opacity: 0.5;">${escapeHtml(formatTime(m.createdAt))}</span>
        </div>
        <div style="margin-top: 2px; white-space: pre-wrap;">${escapeHtml(m.text)}</div>
      </div>
    `,
      )
      .join("");
  }

  async function postAction(routePath, body, statusEl) {
    statusEl.textContent = "…";
    try {
      const res = await fetch(`${BASE_URL}${routePath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        statusEl.textContent = `Error: ${err.error || res.status}`;
        return false;
      }
      return true;
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      return false;
    }
  }

  function renderList(annotations) {
    setThreadHighlight(null);
    if (annotations.length === 0) {
      panelListEl.innerHTML = `<div style="opacity: 0.6;">No annotations on this page yet.</div>`;
      return;
    }

    const statusPill = (s) =>
      `<span style="font-size: 11px; padding: 1px 6px; border-radius: 8px; background: ${s === "open" ? "#4d3800" : "#1e3a24"}; color: ${s === "open" ? "#e5b95c" : "#7ed99a"};">${escapeHtml(s)}</span>`;

    panelListEl.innerHTML = annotations
      .map(
        (a, i) => `
      <div data-thread="${i}" style="border: 1px solid #444; border-radius: 4px; margin-bottom: 6px; padding: 6px;">
        <div data-role="header" style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; gap: 6px;">
          <strong style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(a.label)}</strong>
          ${statusPill(a.status)}
        </div>
        <div data-role="conversation" style="display: none;">
          <div data-role="messages"></div>
          <div style="margin-top: 8px;">
            <textarea data-role="reply" placeholder="Reply…" rows="2" style="width: 100%; box-sizing: border-box; background: #2a2a2a; color: #ddd; border: 1px solid #444; border-radius: 3px; font-family: inherit; font-size: 12px; padding: 4px;"></textarea>
            <div style="display: flex; gap: 6px; margin-top: 4px; align-items: center;">
              <button data-action="reply" style="font-size: 11px;">Reply</button>
              <button data-action="toggle-status" style="font-size: 11px;">${a.status === "open" ? "Resolve" : "Reopen"}</button>
              <span data-role="action-status" style="font-size: 11px; opacity: 0.7;"></span>
            </div>
          </div>
        </div>
      </div>
    `,
      )
      .join("");

    panelListEl.querySelectorAll("[data-thread]").forEach((row) => {
      const idx = Number(row.getAttribute("data-thread"));
      const a = annotations[idx];
      const conversationEl = row.querySelector('[data-role="conversation"]');
      const messagesEl = row.querySelector('[data-role="messages"]');
      const statusEl = row.querySelector('[data-role="action-status"]');
      const replyEl = row.querySelector('[data-role="reply"]');

      const expand = () => {
        conversationEl.style.display = "block";
        messagesEl.innerHTML = renderMessages(a);
        try {
          setThreadHighlight(document.querySelector(a.selector));
        } catch {
          setThreadHighlight(null);
        }
      };

      if (a.id === expandedId) expand();

      row.querySelector('[data-role="header"]').onclick = () => {
        const isOpen = conversationEl.style.display !== "none";
        panelListEl
          .querySelectorAll('[data-role="conversation"]')
          .forEach((c) => (c.style.display = "none"));
        if (isOpen) {
          expandedId = null;
          setThreadHighlight(null);
        } else {
          expandedId = a.id;
          expand();
        }
      };

      row.querySelector('[data-action="reply"]').onclick = async () => {
        const text = replyEl.value.trim();
        if (!text) return;
        if (await postAction("/reply", { threadId: a.id, text }, statusEl)) {
          loadPanel();
        }
      };

      row.querySelector('[data-action="toggle-status"]').onclick = async () => {
        const next = a.status === "open" ? "resolved" : "open";
        if (
          await postAction("/status", { threadId: a.id, status: next }, statusEl)
        ) {
          loadPanel();
        }
      };
    });
  }

  async function loadPanel() {
    if (!panelListEl) return;
    void loadContext();
    panelListEl.innerHTML = `<div style="opacity: 0.6;">Loading…</div>`;
    try {
      const res = await fetch(
        `${ANNOTATIONS_URL}?url=${encodeURIComponent(window.location.href)}`,
      );
      if (!res.ok) {
        panelListEl.innerHTML = `<div style="opacity: 0.6;">Failed to load (${res.status}).</div>`;
        return;
      }
      const { annotations } = await res.json();
      renderList(annotations);
    } catch (err) {
      panelListEl.innerHTML = `<div style="opacity: 0.6;">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  buildPanel();
  loadPanel();

  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("click", onClick, true);

  window.__resolvrAnnotate = {
    stop() {
      document.removeEventListener("mouseover", onMouseOver, true);
      document.removeEventListener("click", onClick, true);
      setHighlight(null);
      setThreadHighlight(null);
      closeCommentBox();
      if (panel) panel.remove();
      panel = null;
      panelListEl = null;
      delete window.__resolvrAnnotate;
    },
    refresh: loadPanel,
  };

  console.log(
    `[resolvr] Annotation mode active — click any element to comment. Posting to ${CAPTURE_URL}. Run window.__resolvrAnnotate.stop() to disable.`,
  );
})();
