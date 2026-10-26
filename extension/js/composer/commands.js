window.CC = window.CC || {};

// Local slash commands answered in the chat (the headless CLI ignores TUI-only ones). One file per command in
// composer/commands/: CC.Commands.add(names, run); run({composer, arg, card}) gets the shared CC.CommandCard.
CC.Commands = (function () {
  const handlers = {};
  return {
    add: function (names, run) {
      [].concat(names).forEach(function (n) {
        handlers[n] = run;
      });
    },
    has: function (name) {
      return handlers[name] != null;
    },
    get: function (name) {
      return handlers[name] || null;
    },
    // A control request's `response` body; rejects on an error reply.
    control: async function (composer, subtype, payload) {
      const res = await composer.deps.control(subtype, payload);
      if (res == null || res.subtype !== "success") {
        throw new Error((res && res.error) || subtype + " failed");
      }
      return res.response || {};
    },
    // The settings file behind a CLI settings source (hooks, permission rules); null when there is none.
    settingsFile: function (composer, source) {
      const cwd = composer.meta.cwd || ".";
      return { userSettings: "~/.claude/settings.json", projectSettings: cwd + "/.claude/settings.json",
        localSettings: cwd + "/.claude/settings.local.json" }[source] || null;
    },
    open: async function (path) {
      try {
        await CC.openPath(path);
      } catch (e) {
        CC.util.toast("Open failed: " + (e && e.message ? e.message : e), "error");
      }
    },
  };
})();

// One card above the composer, styled like the pickers: head (icon, title, close), a body, Esc closes.
CC.CommandCard = (function () {
  const util = CC.util;
  const el = util.el;

  function CommandCard(composer) {
    this.composer = composer;
    this.root = el("div", "prompt-card picker-card cmd-card hidden");
    this.root.tabIndex = -1;
    this.nav = null;
    composer.above.appendChild(this.root);
    const self = this;
    this.root.addEventListener("keydown", function (e) {
      self.onKey(e);
    });
  }

  // Returns the body element to fill.
  CommandCard.prototype.open = function (iconName, title, sub) {
    this.root.textContent = "";
    this.nav = null;
    this.root.classList.remove("hidden");
    const head = el("div", "prompt-head");
    head.appendChild(util.icon(iconName));
    head.appendChild(el("span", "prompt-title", title));
    if (sub) {
      head.appendChild(el("span", "cmd-sub", sub));
    }
    const close = el("button", "icon-btn picker-close");
    close.type = "button";
    close.title = "Close (Esc)";
    close.appendChild(util.icon("x"));
    close.addEventListener("click", this.close.bind(this));
    head.appendChild(close);
    const body = el("div", "cmd-body");
    this.root.append(head, body);
    this.root.focus({ preventScroll: true });
    return body;
  };

  CommandCard.prototype.isOpen = function () {
    return !this.root.classList.contains("hidden");
  };

  CommandCard.prototype.close = function () {
    const had = this.root.contains(document.activeElement);
    this.root.classList.add("hidden");
    this.root.textContent = "";
    this.nav = null;
    if (had) {
      this.composer.focus();
    }
  };

  CommandCard.prototype.hints = function (pairs) {
    const hints = el("div", "prompt-hints");
    pairs.concat([["Esc", "close"]]).forEach(function (it) {
      const s = el("span");
      s.append(el("kbd", null, it[0]), document.createTextNode(" " + it[1]));
      hints.appendChild(s);
    });
    this.root.appendChild(hints);
  };

  // Label / value rows; a value may be a node.
  CommandCard.prototype.rows = function (parent, pairs) {
    const grid = el("div", "cmd-kv");
    pairs.forEach(function (p) {
      grid.appendChild(el("span", "cmd-k", p[0]));
      const v = el("span", "cmd-v");
      if (p[1] instanceof Node) {
        v.appendChild(p[1]);
      } else {
        v.textContent = p[1] == null || p[1] === "" ? "—" : String(p[1]);
      }
      grid.appendChild(v);
    });
    parent.appendChild(grid);
    return grid;
  };

  // Keyboard list: items {label, desc?, sub?, title?, dot? (ok|mid|err), text? (extra search text)}; opts {onPick, search?, query?, empty?, action?}.
  CommandCard.prototype.list = function (parent, items, opts) {
    const self = this;
    const nav = { items: items, shown: items, cursor: 0, box: el("div", "prompt-options picker-list"), onPick: opts.onPick };
    let search = null;
    if (opts.search != null) {
      search = el("input", "picker-search");
      search.type = "text";
      search.placeholder = opts.search;
      search.spellcheck = false;
      search.value = opts.query || "";
      search.addEventListener("input", filter);
      parent.appendChild(search);
      setTimeout(function () {
        search.focus();
      });
    }
    parent.appendChild(nav.box);
    this.hints([["↑↓", "move"], ["Enter", opts.action || "choose"]]);
    function filter() {
      const q = search.value.trim().toLowerCase();
      const hit = function (it) {
        return it.label.toLowerCase().indexOf(q) >= 0;
      };
      nav.shown = items.filter(function (it) {
        return q === "" || [it.label, it.desc, it.sub, it.text].join(" ").toLowerCase().indexOf(q) >= 0;
      });
      nav.shown = nav.shown.filter(hit).concat(nav.shown.filter(function (it) {
        return !hit(it);
      }));
      nav.cursor = 0;
      paint();
    }
    function paint() {
      nav.box.textContent = "";
      if (nav.shown.length === 0) {
        nav.box.appendChild(el("div", "picker-empty", items.length === 0 ? opts.empty || "Nothing here" : "No match"));
        return;
      }
      nav.shown.forEach(function (it, i) {
        const r = el("div", "prompt-option picker-row" + (i === nav.cursor ? " cursor" : ""));
        const body = el("div", "prompt-body");
        const label = el("div", "prompt-label picker-title", it.label);
        if (it.dot) {
          label.prepend(el("span", "cmd-dot cmd-" + it.dot));
        }
        body.appendChild(label);
        if (it.desc) {
          body.appendChild(el("div", "prompt-opt-desc picker-prompt", it.desc));
        }
        if (it.sub) {
          body.appendChild(el("div", "picker-sub", it.sub));
        }
        if (it.title) {
          r.title = it.title;
        }
        r.appendChild(body);
        r.addEventListener("mousedown", function (e) {
          e.preventDefault();
        });
        r.addEventListener("click", function () {
          self.pick(it);
        });
        nav.box.appendChild(r);
      });
    }
    this.nav = nav;
    if (search != null) {
      filter();
    } else {
      paint();
    }
    return nav;
  };

  CommandCard.prototype.pick = function (it) {
    const onPick = this.nav.onPick;
    this.close();
    onPick(it);
  };

  CommandCard.prototype.move = function (d) {
    const nav = this.nav;
    if (nav.shown.length === 0) {
      return;
    }
    nav.cursor = Math.max(0, Math.min(nav.shown.length - 1, nav.cursor + d));
    nav.box.querySelectorAll(".picker-row").forEach(function (r, i) {
      r.classList.toggle("cursor", i === nav.cursor);
      if (i === nav.cursor) {
        r.scrollIntoView({ block: "nearest" });
      }
    });
  };

  CommandCard.prototype.onKey = function (e) {
    if (e.isComposing) {
      return;
    }
    const nav = this.nav;
    if (e.key === "Escape") {
      this.close();
    } else if (nav != null && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      this.move(e.key === "ArrowDown" ? 1 : -1);
    } else if (nav != null && (e.key === "PageDown" || e.key === "PageUp")) {
      this.move(e.key === "PageDown" ? 8 : -8);
    } else if (nav != null && e.key === "Enter" && e.target.tagName !== "BUTTON") {
      if (nav.shown[nav.cursor] != null) {
        this.pick(nav.shown[nav.cursor]);
      }
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return CommandCard;
})();

CC.Composer.use(function (composer) {
  const card = new CC.CommandCard(composer);
  composer.commandCard = card;

  composer.on("beforeSubmit", function () {
    const m = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(composer.value().trim());
    const run = m != null ? CC.Commands.get(m[1]) : null;
    if (run == null) {
      return false;
    }
    composer.setValue("");
    Promise.resolve(run({ composer: composer, arg: (m[2] || "").trim(), card: card })).catch(function (e) {
      CC.util.toast("/" + m[1] + " failed: " + (e && e.message ? e.message : e), "error");
    });
    return true;
  });
});
