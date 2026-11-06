// Local slash commands answered in the chat, because the headless CLI ignores TUI-only ones. One file per command in this folder:
// CC.Commands.add(names, run). run gets {runtime, composer, arg, card}. All per-chat state stays in the composer, card or runtime.
CC.Commands = (function () {
  const handlers = new Map();

  // opts.bare: only answers without an argument; `/model opus` stays prompt text for the CLI.
  function add(names, run, opts) {
    [].concat(names).forEach(function (n) {
      handlers.set(n, { run: run, bare: opts != null && opts.bare === true });
    });
  }

  function message(e) {
    return e && e.message ? e.message : String(e);
  }

  function toast(text, level) {
    CC.ui.toast(text, level === "error" ? { level: "error" } : undefined);
  }

  // A control request's `response` body; rejects on an error reply.
  async function control(runtime, subtype, payload) {
    const res = await runtime.control(subtype, payload);
    if (res == null || res.subtype !== "success") {
      throw new Error((res && res.error) || subtype + " failed");
    }
    return res.response || {};
  }

  function isWorking(runtime) {
    const st = runtime.status();
    return st === "busy" || st === "waiting";
  }

  function cwdOf(runtime) {
    return runtime.meta().cwd || runtime.cwd || ".";
  }

  // The settings file behind a CLI settings source (hooks, permission rules); null when there is none.
  function settingsFile(runtime, source) {
    const cwd = cwdOf(runtime);
    return { userSettings: "~/.claude/settings.json", projectSettings: cwd + "/.claude/settings.json",
      localSettings: cwd + "/.claude/settings.local.json" }[source] || null;
  }

  function askServer(runtime, path) {
    return CC.Servers.of(runtime).host.call("openFile", { path: path, cwd: runtime != null ? cwdOf(runtime) : null, file: runtime != null ? runtime.transcriptFile() : null });
  }

  function isMissing(e) {
    return /not found/.test(message(e));
  }

  // Without the open-file bridge the server refuses; the page still has its own way to show a path.
  function openElsewhere(path, line) {
    CC.bus.emit("path:open", { path: path, line: line });
  }

  async function open(runtime, path) {
    try {
      await askServer(runtime, path);
    } catch (e) {
      if (isMissing(e)) {
        toast("Open failed: " + message(e), "error");
      } else {
        openElsewhere(path);
      }
    }
  }

  // The first of `paths` that exists; `missing` is the toast when none does.
  async function openFirst(runtime, paths, missing) {
    for (const path of paths) {
      try {
        await askServer(runtime, path);
        return;
      } catch (e) {
        if (!isMissing(e)) {
          openElsewhere(path);
          return;
        }
      }
    }
    toast(missing, "error");
  }

  // Agent definitions: the wire has no path for them.
  function openAgent(runtime, agentName) {
    const name = agentName.replace(/[^\w.-]/g, "");
    return openFirst(runtime, [cwdOf(runtime) + "/.claude/agents/" + name + ".md", "~/.claude/agents/" + name + ".md"], "No .claude/agents/" + name + ".md (built-in or plugin agent)");
  }

  // C2 brings CC.markdown; without it, plain text beats a blank card.
  function markdown(text, opts) {
    if (CC.markdown != null && CC.markdown.render != null) {
      return CC.markdown.render(text, opts);
    }
    return CC.util.el("div", "cc-cmd-plain", text);
  }

  function dispatch(composer, text) {
    return composer.dispatch({ id: CC.util.uid(), text: text, images: [], previews: [], createdAt: Date.now() }, false);
  }

  // Runs a local command if the text is one. True when it took the text.
  function handle(composer, text) {
    const m = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    const h = m != null ? handlers.get(m[1]) : null;
    const arg = m != null ? (m[2] || "").trim() : "";
    if (h == null || (h.bare && arg !== "")) {
      return false;
    }
    composer.setValue("");
    new Promise(function (resolve) {
      resolve(h.run({ runtime: composer.runtime, composer: composer, arg: arg, card: composer.commandCard }));
    }).then(function (view) {
      if (composer.commandCard != null) {
        composer.commandCard.own(view);
      }
    }).catch(function (e) {
      toast("/" + m[1] + " failed: " + message(e), "error");
    });
    return true;
  }

  // One composer gets one card. `host` is where the card goes; a 2.x style composer has `above`. `runtime.composer` is how Edit, called from
  // a prompt's icon, finds the field to fill.
  function attach(composer, opts) {
    const o = opts || {};
    composer.runtime = o.runtime || composer.runtime;
    composer.commandCard = new CC.CommandCard(composer, o.host || composer.commandHost || composer.above);
    composer.runtime.composer = composer;
    composer.on("beforeSubmit", function () {
      return handle(composer, composer.value());
    });
    return composer.commandCard;
  }

  return {
    add: add, has: function (name) {
      return handlers.has(name);
    }, get: function (name) {
      return handlers.has(name) ? handlers.get(name).run : null;
    }, names: function () {
      return Array.from(handlers.keys());
    },
    control: control, toast: toast, message: message, isWorking: isWorking, cwdOf: cwdOf, settingsFile: settingsFile, open: open, openFirst: openFirst, openAgent: openAgent,
    markdown: markdown, dispatch: dispatch, handle: handle, attach: attach,
  };
})();

// One card above the composer: head (icon, title, close), a body, Esc closes.
CC.CommandCard = (function () {
  const el = CC.util.el;

  function CommandCard(composer, host) {
    this.composer = composer;
    this.root = el("div", "cc-cmd-card cc-floating");
    this.root.tabIndex = -1;
    this.root.hidden = true;
    this.nav = null;
    this.view = null;
    host.appendChild(this.root);
    const self = this;
    this.root.addEventListener("keydown", function (e) {
      self.onKey(e);
    });
  }

  // Returns the body element to fill.
  CommandCard.prototype.open = function (iconName, title, sub) {
    this.releaseView();
    this.root.replaceChildren();
    this.nav = null;
    this.root.hidden = false;
    const head = el("div", "cc-cmd-head");
    head.appendChild(CC.ui.icon(iconName, 14));
    head.appendChild(el("span", "cc-cmd-title", title));
    if (sub) {
      head.appendChild(el("span", "cc-cmd-sub", sub));
    }
    const self = this;
    head.appendChild(CC.ui.iconButton({ icon: "x", label: "Close (Esc)", size: 14, onClick: function () {
      self.close();
    } }));
    const body = el("div", "cc-cmd-body");
    this.root.append(head, body);
    this.root.focus({ preventScroll: true });
    return body;
  };

  CommandCard.prototype.isOpen = function () {
    return !this.root.hidden;
  };

  // What a command returned, if it mounted something with a timer or a listener: unmounted when the card closes or shows something else.
  CommandCard.prototype.own = function (view) {
    if (view == null || view.unmount == null) {
      return;
    }
    if (this.isOpen()) {
      this.view = view;
    } else {
      view.unmount();
    }
  };

  CommandCard.prototype.releaseView = function () {
    const view = this.view;
    this.view = null;
    if (view != null) {
      view.unmount();
    }
  };

  CommandCard.prototype.close = function () {
    this.releaseView();
    const active = document.activeElement;
    const had = this.root.contains(active) || active == null || active === document.body;
    this.root.hidden = true;
    this.root.replaceChildren();
    this.nav = null;
    if (had) {
      this.composer.focus();
    }
  };

  CommandCard.prototype.hints = function (pairs) {
    const hints = el("div", "cc-cmd-hints");
    pairs.concat([["Esc", "close"]]).forEach(function (it) {
      const s = el("span");
      s.append(el("kbd", null, it[0]), document.createTextNode(" " + it[1]));
      hints.appendChild(s);
    });
    this.root.appendChild(hints);
  };

  // Label / value rows; a value may be a node.
  CommandCard.prototype.rows = function (parent, pairs) {
    const grid = el("div", "cc-cmd-kv");
    pairs.forEach(function (p) {
      grid.appendChild(el("span", "cc-cmd-k", p[0]));
      const v = el("span", "cc-cmd-v");
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

  // Keyboard list: items {label, desc?, sub?, title?, dot? (ok|mid|err|off), chosen?, text? (extra search text)};
  // opts {onPick, search?, query?, empty?, action?, numbers? (keys 1-9), segment? (one row, ←/→ too), extra? (node after the list)}.
  CommandCard.prototype.list = function (parent, items, opts) {
    const self = this;
    const nav = { items: items, shown: items, cursor: 0, box: el("div", opts.segment ? "cc-cmd-seg" : "cc-cmd-list-box"), onPick: opts.onPick, numbers: opts.numbers === true, segment: opts.segment === true };
    let search = null;
    if (opts.search != null) {
      search = el("input", "cc-cmd-search");
      search.type = "text";
      search.placeholder = opts.search;
      search.setAttribute("aria-label", opts.search);
      search.spellcheck = false;
      search.value = opts.query || "";
      search.addEventListener("input", filter);
      parent.appendChild(search);
      setTimeout(function () {
        search.focus();
      });
    }
    parent.appendChild(nav.box);
    if (opts.extra != null) {
      parent.appendChild(opts.extra);
    }
    this.hints([[nav.segment ? "←→" : "↑↓", "move"], ["Enter", opts.action || "choose"]]);

    function filter() {
      const q = search.value.trim().toLowerCase();
      const hit = function (it) {
        return it.label.toLowerCase().indexOf(q) >= 0;
      };
      const all = items.filter(function (it) {
        return q === "" || [it.label, it.desc, it.sub, it.text].join(" ").toLowerCase().indexOf(q) >= 0;
      });
      nav.shown = all.filter(hit).concat(all.filter(function (it) {
        return !hit(it);
      }));
      nav.cursor = 0;
      paint();
    }

    function rowOf(it, i) {
      const r = el("button", "cc-cmd-row" + (it.chosen ? " is-chosen" : "") + (i === nav.cursor ? " is-cursor" : ""));
      r.type = "button";
      r.tabIndex = -1;
      if (nav.segment) {
        r.textContent = it.label;
      } else {
        if (nav.numbers) {
          r.appendChild(el("span", "cc-cmd-num", String(i + 1)));
        }
        const body = el("span", "cc-cmd-row-body");
        const label = el("span", "cc-cmd-row-title", it.label);
        if (it.dot) {
          label.prepend(el("span", "cc-cmd-dot is-" + it.dot));
        }
        body.appendChild(label);
        if (it.desc) {
          body.appendChild(el("span", "cc-cmd-row-desc", it.desc));
        }
        if (it.sub) {
          body.appendChild(el("span", "cc-cmd-row-sub", it.sub));
        }
        r.appendChild(body);
        if (it.chosen) {
          r.appendChild(CC.ui.icon("check", 14));
        }
      }
      if (it.title) {
        r.title = it.title;
      }
      r.addEventListener("mousedown", function (e) {
        e.preventDefault();
      });
      r.addEventListener("click", function () {
        self.pick(it);
      });
      return r;
    }

    function paint() {
      nav.box.replaceChildren();
      if (nav.shown.length === 0) {
        nav.box.appendChild(el("div", "cc-cmd-empty", items.length === 0 ? opts.empty || "Nothing here" : "No match"));
        return;
      }
      nav.shown.forEach(function (it, i) {
        nav.box.appendChild(rowOf(it, i));
      });
    }

    this.nav = nav;
    if (search != null) {
      filter();
    } else {
      const at = items.findIndex(function (it) {
        return it.chosen === true;
      });
      nav.cursor = Math.max(0, at);
      paint();
    }
    return nav;
  };

  CommandCard.prototype.pick = function (it) {
    const onPick = this.nav.onPick;
    this.close();
    onPick(it);
  };

  // Keeps within the list: no wrap around, since a long list jumps by pages too.
  CommandCard.prototype.move = function (d) {
    const nav = this.nav;
    if (nav.shown.length === 0) {
      return;
    }
    nav.cursor = Math.max(0, Math.min(nav.shown.length - 1, nav.cursor + d));
    Array.from(nav.box.children).forEach(function (r, i) {
      r.classList.toggle("is-cursor", i === nav.cursor);
      if (i === nav.cursor && r.scrollIntoView != null) {
        r.scrollIntoView({ block: "nearest" });
      }
    });
  };

  // Buttons at the end of a card body: [{label, primary, run}]. Returns the row.
  CommandCard.prototype.actions = function (parent, buttons) {
    const row = el("div", "cc-cmd-actions");
    buttons.forEach(function (b) {
      row.appendChild(CC.ui.button({ label: b.label, primary: b.primary, onClick: b.run }));
    });
    parent.appendChild(row);
    return row;
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
    } else if (nav != null && nav.segment && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      this.move(e.key === "ArrowRight" ? 1 : -1);
    } else if (nav != null && (e.key === "PageDown" || e.key === "PageUp")) {
      this.move(e.key === "PageDown" ? 8 : -8);
    } else if (nav != null && e.key === "Enter" && e.target.tagName !== "BUTTON") {
      if (nav.shown[nav.cursor] != null) {
        this.pick(nav.shown[nav.cursor]);
      }
    } else if (nav != null && nav.numbers && /^[1-9]$/.test(e.key) && nav.shown[Number(e.key) - 1] != null) {
      this.pick(nav.shown[Number(e.key) - 1]);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return CommandCard;
})();

Object.assign(CC.icons, {
  agents: '<path d="M12 8V4H8"/><rect x="4" y="8" width="12" height="10" rx="2"/><path d="M9 12v2"/><path d="M13 12v2"/><path d="M19 11h2v8a2 2 0 0 1-2 2h-8v-2"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.900a2.100 2.100 0 0 1-3-3l6.900-6.900a6 6 0 0 1 7.900-7.900z"/>',
  sparkle: '<path d="M12 3l1.900 5.800L20 10.700l-6.100 1.900L12 18.500l-1.900-5.900L4 10.700l6.100-1.900z"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  checkSquare: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>',
  square: '<rect x="3" y="3" width="18" height="18" rx="4"/>',
  circleDot: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  brain: '<path d="M9.500 2A2.500 2.500 0 0 0 7 4.500v.1A3 3 0 0 0 4.500 9a3 3 0 0 0 .5 5.300V15a3 3 0 0 0 4.500 2.600v1.900A2.500 2.500 0 0 0 12 22V4.500A2.500 2.500 0 0 0 9.500 2z"/><path d="M14.500 2A2.500 2.500 0 0 1 17 4.500v.1A3 3 0 0 1 19.500 9a3 3 0 0 1-.5 5.300V15a3 3 0 0 1-4.500 2.600v1.900A2.500 2.500 0 0 1 12 22"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
});

// C3's composer loads first; a composer that takes plugins gets the card and the commands by itself.
if (CC.Composer != null && typeof CC.Composer.use === "function") {
  CC.Composer.use(function (composer) {
    CC.Commands.attach(composer);
  });
}
