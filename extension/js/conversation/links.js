// Paths and links inside rendered text. One delegated listener per view (CC.links.bind), so nothing leaks with the text.
// Without a bridge on a remote server a path opens in the file pane or gets copied; never an error.
CC.links = (function () {
  const OPEN_WITH = [
    { app: "zed", label: "Open in Zed" },
    { app: "idea", label: "Open in IntelliJ" },
    { app: "finder", label: "Reveal in Finder" },
  ];
  const COPY_OVER_PX = 14;
  const COPY_ABOVE_PX = 14;
  const DRAG_PX = 4;
  // Page-wide fact about this server: learnt from the first refusal, then the menu stops offering what can't work.
  let noBridge = false;

  function isPath(text) {
    return /^(file:\/\/)?\.{0,2}\/?[\w.@~+-]+(\/[\w.@~+-]+)+(:\d+){0,2}$/.test(text) || /^\/[\w.@~+-]+(\/[\w.@~+-]+)*(:\d+){0,2}$/.test(text);
  }

  function copy(text) {
    CC.util.copyText(text).then(function (ok) {
      CC.ui.toast(ok ? "Copied" : "Copy failed", ok ? null : { level: "error" });
    });
  }

  function splitLine(target) {
    const m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(target.replace(/^file:\/\//, ""));
    return { path: m[1], line: m[2] != null ? Number(m[2]) : null };
  }

  function serverOf(ctx) {
    return ctx != null && ctx.server != null ? ctx.server : CC.Servers.focused();
  }

  function toFilePane(target, ctx) {
    const at = splitLine(target);
    const absolute = at.path.charAt(0) === "/" || at.path.charAt(0) === "~" || !ctx.cwd ? at.path : ctx.cwd.replace(/\/+$/, "") + "/" + at.path.replace(/^\.\//, "");
    CC.bus.emit("path:open", { path: absolute, line: at.line, chatId: ctx.chatId || null, cwd: ctx.cwd || null });
  }

  async function openInApp(target, app, ctx) {
    try {
      await serverOf(ctx).host.call("openFile", { path: target, app: app, cwd: ctx.cwd || null, file: ctx.file != null ? ctx.file() : null });
    } catch (e) {
      if (/bridge/i.test(String(e && e.message))) {
        noBridge = true;
        toFilePane(target, ctx);
      } else {
        CC.ui.toast("Couldn't open it: " + (e && e.message), { level: "error" });
      }
    }
  }

  function pathItems(target, ctx) {
    const items = [{ label: "Open in file pane", icon: "file", run: function () { toFilePane(target, ctx); } }];
    if (!noBridge) {
      OPEN_WITH.forEach(function (o) {
        items.push({ label: o.label, run: function () { openInApp(target, o.app, ctx); } });
      });
    }
    items.push({ label: "Copy path", icon: "copy", run: function () { copy(target); } });
    return items;
  }

  async function openDefault(url, ctx) {
    try {
      await serverOf(ctx).host.call("openUrl", { url: url });
    } catch (e) {
      Promise.resolve(CC.host.ui.openBrowser(url)).catch(function () {
        copy(url);
      });
    }
  }

  function urlItems(url, ctx) {
    return [
      { label: "Open in default browser", run: function () { openDefault(url, ctx); } },
      { label: "Open in Muxy browser", run: function () { Promise.resolve(CC.host.ui.openBrowser(url)).catch(function () { copy(url); }); } },
      { label: "Copy link", icon: "copy", run: function () { copy(url); } },
    ];
  }

  function open(e, href, ctx) {
    const target = String(href).replace(/#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/, function (m, line, col) {
      return ":" + line + (col ? ":" + col : "");
    });
    const at = { at: { x: e.clientX, y: e.clientY } };
    if (e.metaKey) {
      copy(target);
    } else if (/^https?:\/\//i.test(target)) {
      CC.ui.menu(urlItems(target, ctx), at);
    } else if (isPath(target)) {
      CC.ui.menu(pathItems(target, ctx), at);
    } else {
      copy(target);
    }
  }

  // ctx: {cwd, chatId, file: fn → transcript file, server}, each read at click time.
  function bind(root, getCtx) {
    function onClick(e) {
      const t = e.target;
      if (t == null || t.closest == null) {
        return;
      }
      const link = t.closest("a[data-href]");
      const path = link == null ? t.closest(".path-link") : null;
      const img = link == null && path == null ? t.closest("img.md-img") : null;
      if (link != null) {
        e.preventDefault();
        open(e, link.getAttribute("data-href"), getCtx());
      } else if (path != null) {
        e.preventDefault();
        open(e, path.getAttribute("data-path"), getCtx());
      } else if (img != null) {
        e.preventDefault();
        CC.images.open(img.src, img);
      }
    }
    // error doesn't bubble; capture sees it.
    function onError(e) {
      const img = e.target;
      if (img != null && img.tagName === "IMG" && img.classList.contains("md-img")) {
        img.replaceWith(CC.util.el("span", "md-image", "[image: " + (img.alt || img.getAttribute("src")) + "]"));
      }
    }
    root.addEventListener("click", onClick);
    root.addEventListener("error", onError, true);
    return function () {
      root.removeEventListener("click", onClick);
      root.removeEventListener("error", onError, true);
    };
  }

  // Inline code in rendered text: fenced blocks have their own button, a path opens its menu.
  function inlineCode(target) {
    const c = target != null && target.closest != null ? target.closest(".md code:not(.path-link)") : null;
    return c != null && c.parentNode.tagName !== "PRE" ? c : null;
  }

  // A click anywhere on inline code copies it, unless the mouse dragged a selection, and the one copy icon of a view sits on the corner of the
  // span under the mouse. Fixed, so it takes no room; placed from the span, so it stays while the mouse moves. A wrapped span has it on its first line.
  function bindInlineCopy(root, host) {
    let current = null;
    let pressedAt = null;
    const btn = CC.conv.copyButton(function () {
      return current != null ? current.textContent : "";
    });
    btn.classList.add("cv-inline-copy");
    function hide() {
      current = null;
      btn.remove();
    }
    function show(c) {
      current = c;
      const corner = c.getClientRects()[0];
      if (corner == null) {
        return;
      }
      btn.style.left = corner.right - COPY_OVER_PX + "px";
      btn.style.top = Math.max(root.getBoundingClientRect().top, corner.top - COPY_ABOVE_PX) + "px";
      if (btn.parentNode == null) {
        host.appendChild(btn);
      }
    }
    function onMove(e) {
      if (e.target === btn || btn.contains(e.target)) {
        return;
      }
      const c = e.buttons === 0 ? inlineCode(e.target) : null;
      if (c != null) {
        show(c);
      } else if (current != null && !btn.classList.contains("is-copied")) {
        hide();
      }
    }
    function onLeave() {
      setTimeout(hide, btn.classList.contains("is-copied") ? 900 : 0);
    }
    function onDown(e) {
      pressedAt = { x: e.clientX, y: e.clientY };
    }
    function onClick(e) {
      const c = inlineCode(e.target);
      const dragged = pressedAt != null && Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) >= DRAG_PX;
      const selection = window.getSelection();
      const selecting = selection != null && !selection.isCollapsed;
      if (c == null || e.button !== 0 || e.detail > 1 || dragged || selecting || c.closest("a") != null) {
        return;
      }
      show(c);
      btn.click();
    }
    root.addEventListener("mousemove", onMove);
    root.addEventListener("mousedown", onDown);
    root.addEventListener("click", onClick);
    root.addEventListener("scroll", hide, { passive: true });
    btn.addEventListener("mouseleave", onLeave);
    return function () {
      root.removeEventListener("mousemove", onMove);
      root.removeEventListener("mousedown", onDown);
      root.removeEventListener("click", onClick);
      root.removeEventListener("scroll", hide);
      hide();
    };
  }

  return { bind: bind, bindInlineCopy: bindInlineCopy, isPath: isPath };
})();
