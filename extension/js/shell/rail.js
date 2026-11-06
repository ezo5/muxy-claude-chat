// Right rail: cards about the focused chat. The shell tells it where to draw and for which pane; cards register at any time.
CC.Rail = (function () {
  const defs = new Map();
  let root = null;
  let host = null;
  let ctx = null;
  let openState = {};
  let mounted = [];

  function ordered() {
    return Array.from(defs.entries()).sort(function (a, b) {
      return (a[1].order || 0) - (b[1].order || 0);
    });
  }

  function isVisible(def) {
    if (def.visible == null) {
      return true;
    }
    try {
      return def.visible(ctx) === true;
    } catch (e) {
      console.error("rail card visible", e);
      return false;
    }
  }

  function unmountAll() {
    mounted.forEach(function (m) {
      if (m.handle != null && m.handle.unmount != null) {
        m.handle.unmount();
      }
    });
    mounted = [];
    if (host != null) {
      host.replaceChildren();
    }
  }

  function saveOpen() {
    CC.Servers.appKv().set("ui", "rail", openState).catch(function (e) {
      console.warn("rail state not saved:", e && e.message);
    });
  }

  function mountCard(id, def) {
    const entry = { id: id, def: def, handle: null, el: null };
    entry.el = CC.ui.card({
      title: def.title,
      icon: def.icon,
      open: openState[id] !== false,
      status: function () {
        return def.status != null ? def.status(ctx) : null;
      },
      onToggle: function (open) {
        openState[id] = open;
        saveOpen();
      },
      body: function (el) {
        try {
          entry.handle = def.mount(el, ctx) || null;
        } catch (e) {
          console.error("rail card " + id, e);
          el.textContent = "This card couldn't load: " + e.message;
        }
      },
    });
    mounted.push(entry);
    host.appendChild(entry.el);
  }

  // Cards are rebuilt on a change of chat. A refresh keeps mounted ones, so what a card holds survives its own status change.
  function render() {
    unmountAll();
    if (host == null || ctx == null) {
      return;
    }
    ordered().forEach(function (pair) {
      if (isVisible(pair[1])) {
        mountCard(pair[0], pair[1]);
      }
    });
  }

  function refresh() {
    if (host == null || ctx == null) {
      return;
    }
    const wanted = ordered().filter(function (pair) {
      return isVisible(pair[1]);
    }).map(function (pair) {
      return pair[0];
    });
    const shown = mounted.map(function (m) {
      return m.id;
    });
    if (wanted.join("\n") !== shown.join("\n")) {
      render();
      return;
    }
    mounted.forEach(function (m) {
      m.el.refreshStatus();
    });
  }

  // Opens a card and brings it into view. False when the rail isn't on screen or the card isn't showing.
  function reveal(id) {
    if (host == null || root.hidden || window.getComputedStyle(root).display === "none") {
      return false;
    }
    const m = mounted.find(function (x) {
      return x.id === id;
    });
    if (m == null) {
      return false;
    }
    if (!m.el.isOpen()) {
      m.el.setOpen(true);
      openState[id] = true;
      saveOpen();
    }
    if (m.el.scrollIntoView != null) {
      m.el.scrollIntoView({ block: "nearest" });
    }
    return true;
  }

  function register(id, def) {
    const current = defs.get(id);
    if (current != null && current.fallback !== true && def.fallback === true) {
      return;
    }
    defs.set(id, def);
    render();
  }

  return {
    register: register,
    refresh: refresh,
    reveal: reveal,
    // Shell only.
    attach: function (el, saved) {
      root = el;
      host = CC.util.el("div", "cc-rail-cards");
      root.replaceChildren(CC.ui.bar({ title: "Details" }), host);
      openState = saved || {};
    },
    show: function (paneCtx) {
      ctx = paneCtx;
      render();
    },
  };
})();
