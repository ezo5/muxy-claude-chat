// Settings as a full view, pane kind `settings`: a list of sections on the left, rows of title, one grey sentence and a control on the right.
// A setting's owner adds a section:
//   CC.SettingsView.section(id, {label, order, fallback?, render(body, ui)})    // render may return a cleanup function
// `ui` holds the row and control factories below. A real section replaces a `fallback` of the same id, in any load order.
CC.SettingsView = (function () {
  const el = CC.util.el;
  const sections = new Map();
  const views = new Set();

  function section(id, def) {
    const current = sections.get(id);
    if (current != null && current.fallback !== true && def.fallback === true) {
      return;
    }
    sections.set(id, Object.assign({ id: id, order: 100 }, def));
    views.forEach(function (v) {
      v.paintNav();
    });
  }

  function ordered() {
    return Array.from(sections.values()).sort(function (a, b) {
      return a.order - b.order;
    });
  }

  // --- rows and controls ---

  function group(parent, title) {
    const g = el("div", "cc-set-group");
    if (title != null) {
      g.appendChild(el("h3", "cc-set-group-title", title));
    }
    parent.appendChild(g);
    return g;
  }

  // opts: {title, text, control: node, wide: control under the words}
  function row(parent, opts) {
    const r = el("div", "cc-set-row" + (opts.wide ? " is-wide" : ""));
    const words = el("div", "cc-set-words");
    const title = el("div", "cc-set-title", opts.title);
    words.appendChild(title);
    if (opts.text != null) {
      words.appendChild(el("div", "cc-set-text", opts.text));
    }
    r.appendChild(words);
    if (opts.control != null) {
      const ctl = el("div", "cc-set-control");
      ctl.appendChild(opts.control);
      const field = opts.control.matches("input, select") ? opts.control : opts.control.querySelector("input, select");
      if (field != null && !field.hasAttribute("aria-label")) {
        field.setAttribute("aria-label", opts.title);
      }
      r.appendChild(ctl);
    }
    parent.appendChild(r);
    return r;
  }

  function toggle(value, onChange) {
    const wrap = el("label", "cc-set-switch");
    const input = el("input");
    input.type = "checkbox";
    input.setAttribute("role", "switch");
    input.checked = value === true;
    input.addEventListener("change", function () {
      onChange(input.checked);
    });
    wrap.append(input, el("span", "cc-set-switch-track"));
    return wrap;
  }

  // options: [[value, label]]
  function select(options, value, onChange) {
    const s = el("select", "cc-set-select");
    options.forEach(function (o) {
      const opt = el("option", null, o[1]);
      opt.value = o[0];
      opt.selected = o[0] === value;
      s.appendChild(opt);
    });
    s.addEventListener("change", function () {
      onChange(s.value);
    });
    return s;
  }

  function slider(o) {
    const wrap = el("div", "cc-set-range");
    const input = el("input");
    input.type = "range";
    input.min = String(o.min);
    input.max = String(o.max);
    input.step = String(o.step);
    input.value = String(o.value);
    const out = el("span", "cc-set-value", o.format(o.value));
    input.addEventListener("input", function () {
      const v = Number(input.value);
      out.textContent = o.format(v);
      o.onChange(v);
    });
    wrap.append(input, out);
    return wrap;
  }

  function text(value, placeholder, onChange) {
    const input = el("input", "cc-set-input");
    input.type = "text";
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.value = value;
    input.addEventListener("input", function () {
      onChange(input.value);
    });
    return input;
  }

  const ui = { group: group, row: row, toggle: toggle, select: select, slider: slider, text: text };

  // --- the view ---

  function View(host, ctx) {
    this.ctx = ctx;
    this.active = ctx.params != null && sections.has(ctx.params.section) ? ctx.params.section : ordered()[0].id;
    const focused = CC.Shell.focused();
    this.lastChat = focused != null && focused.kind === "chat" ? focused.chatId : null;
    this.cleanup = null;
    this.mine = false;
    this.root = el("div", "cc-set");
    this.nav = el("nav", "cc-set-nav");
    this.nav.setAttribute("aria-label", "Settings sections");
    this.page = el("div", "cc-set-page");
    const inner = el("div", "cc-set-in");
    inner.append(this.nav, this.page);
    this.root.appendChild(inner);
    host.appendChild(this.root);
    const self = this;
    // Changes from this view's own controls must not repaint it under a dragged slider. They reach the bus synchronously, between these two.
    ["input", "change", "click"].forEach(function (name) {
      self.root.addEventListener(name, function () {
        self.mine = true;
      }, true);
      self.root.addEventListener(name, function () {
        self.mine = false;
      });
    });
    this.offs = [
      CC.bus.on("settings:changed", function () {
        if (!self.mine) {
          self.paint();
        }
      }),
      CC.bus.on("shell:changed", function (e) {
        const chat = e.panes.find(function (p) {
          return p.focused && p.kind === "chat";
        });
        if (chat != null) {
          self.lastChat = chat.chatId;
        }
      }),
    ];
    this.paintNav();
    this.paint();
  }

  // The chat "this chat" means: the last one in focus, while it's still on screen, else any on screen.
  View.prototype.chatRuntime = function () {
    const panes = CC.Shell.panes().filter(function (p) {
      return p.kind === "chat" && p.chatId != null;
    });
    const self = this;
    const pane = panes.find(function (p) {
      return p.chatId === self.lastChat;
    }) || panes[0];
    return pane != null && CC.Chats != null ? CC.Chats.open(pane.chatId) : null;
  };

  View.prototype.paintNav = function () {
    const self = this;
    this.nav.replaceChildren();
    ordered().forEach(function (s) {
      const b = el("button", "cc-set-tab" + (s.id === self.active ? " is-active" : ""), s.label);
      b.type = "button";
      if (s.id === self.active) {
        b.setAttribute("aria-current", "page");
      }
      b.addEventListener("click", function () {
        self.show(s.id);
      });
      self.nav.appendChild(b);
    });
  };

  View.prototype.show = function (id) {
    if (sections.has(id)) {
      this.active = id;
      this.paintNav();
      this.paint();
    }
  };

  View.prototype.paint = function () {
    if (this.cleanup != null) {
      this.cleanup();
      this.cleanup = null;
    }
    const s = sections.get(this.active);
    const top = this.page.scrollTop;
    this.page.replaceChildren();
    const body = el("div", "cc-set-body");
    body.appendChild(el("h2", "cc-set-heading", s.label));
    this.page.appendChild(body);
    try {
      const done = s.render(body, Object.assign({ view: this }, ui));
      this.cleanup = typeof done === "function" ? done : null;
    } catch (e) {
      console.error("settings section " + s.id, e);
      body.appendChild(el("div", "cc-cmd-empty", "This section couldn't load: " + e.message));
    }
    this.page.scrollTop = top;
  };

  View.prototype.unmount = function () {
    this.offs.forEach(function (off) {
      off();
    });
    if (this.cleanup != null) {
      this.cleanup();
    }
    views.delete(this);
  };

  CC.Panes.register("settings", {
    title: function () {
      return "Settings";
    },
    mount: function (host, ctx) {
      const view = new View(host, ctx);
      views.add(view);
      return {
        unmount: function () {
          view.unmount();
        },
        update: function (params) {
          if (params.section != null) {
            view.show(params.section);
          }
        },
        focus: function () {
          const on = view.nav.querySelector(".is-active");
          if (on != null) {
            on.focus({ preventScroll: true });
          }
        },
      };
    },
  });

  // Beside what you're reading. An open view keeps its place unless a section is named.
  function open(opts) {
    const section = opts != null ? opts.section : null;
    const params = section != null ? { section: section } : {};
    CC.Shell.open({ kind: "settings", params: params }, { beside: true });
  }

  return { section: section, open: open, ui: ui };
})();

CC.Keys.bind("mod+,", {
  scope: "global",
  run: function () {
    CC.SettingsView.open();
  },
});
