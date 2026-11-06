// Pane kinds `file` (rendered .md or highlighted source, from a path link) and `plan` (the chat's plan).
(function () {
  const el = CC.util.el;
  const D = CC.reviewDiff;
  const MAX_LINES = 20000;

  function chatCwd(ctx) {
    const rt = ctx.runtime;
    const meta = rt != null && typeof rt.meta === "function" ? rt.meta() : null;
    if (meta != null && meta.cwd) {
      return meta.cwd;
    }
    const row = ctx.chatId != null && CC.Chats != null ? CC.Chats.get(ctx.chatId) : null;
    return row != null && row.cwd ? row.cwd : null;
  }

  // Rendered markdown, or the plain text while no renderer is there.
  function renderMarkdown(text, cwd) {
    const box = el("div", "rv-md");
    if (CC.markdown != null && CC.markdown.render != null) {
      box.appendChild(CC.markdown.render(text, { cwd: cwd }));
    } else {
      box.classList.add("is-plain");
      box.textContent = text;
    }
    return box;
  }

  function isMarkdown(path) {
    return /\.(md|markdown|mdx)$/i.test(path || "");
  }

  // The end of a path is what matters, so the cut is on the left; <bdi> keeps its slashes and dots in order under direction: rtl.
  function setPath(node, text) {
    node.replaceChildren(el("bdi", null, text));
    node.title = text;
  }

  function FileView(host, ctx) {
    const self = this;
    this.ctx = ctx;
    ctx.view = this;
    this.params = ctx.params;
    this.seq = 0;
    this.lines = null;
    this.rendered = isMarkdown(ctx.params.path);
    this.disposed = false;
    this.el = el("div", "rv-fp");
    this.pathEl = el("div", "rv-fp-path");
    this.scroll = el("div", "rv-fp-scroll");
    this.body = el("div", "rv-fp-body");
    this.scroll.appendChild(this.body);
    this.el.append(this.pathEl);
    this.find = new CC.ReviewFind({ scroller: this.scroll, root: this.body, mount: this.el, roots: ".rv-code, .rv-md", placeholder: "Find in file" });
    this.el.append(this.scroll);
    host.appendChild(this.el);
    this.load();
  }

  FileView.prototype.dispose = function () {
    this.disposed = true;
    this.find.dispose();
  };

  FileView.prototype.cwd = function () {
    return this.params.cwd || chatCwd(this.ctx);
  };

  // Another path in the same pane. A link to the file already shown only moves to its line.
  FileView.prototype.show = function (params) {
    const same = params.path === this.params.path;
    this.params = Object.assign({}, this.params, { path: params.path, line: params.line != null ? params.line : null, cwd: params.cwd || this.params.cwd || null });
    if (this.ctx.setParams != null) {
      this.ctx.setParams(this.params);
    }
    if (same && this.lines != null) {
      this.goToLine();
      return;
    }
    this.rendered = isMarkdown(params.path);
    this.load();
  };

  FileView.prototype.title = function () {
    return this.params.path != null ? D.baseOf(this.params.path) : "File";
  };

  FileView.prototype.actions = function () {
    const self = this;
    const out = [];
    if (isMarkdown(this.params.path) && this.lines != null) {
      out.push({ icon: this.rendered ? "file" : "list", label: this.rendered ? "Show the source" : "Show rendered", run: function () {
        self.rendered = !self.rendered;
        self.draw();
        self.ctx.setTitle();
      } });
    }
    out.push({ icon: "copy", label: "Copy path", run: function () {
      CC.util.copyText(self.params.path || "").then(function (ok) {
        CC.ui.toast(ok ? "Path copied" : "The path couldn't be copied", { level: ok ? "info" : "error" });
      });
    } });
    out.push({ icon: "refresh", label: "Reload the file", run: function () {
      self.load();
    } });
    return out;
  };

  FileView.prototype.load = async function () {
    const seq = ++this.seq;
    const path = this.params.path;
    setPath(this.pathEl, CC.util.shortPath(path || "", this.cwd()));
    this.lines = null;
    if (!path) {
      this.body.replaceChildren(el("div", "cc-empty", "No file to show."));
      this.ctx.setTitle();
      return;
    }
    this.body.replaceChildren(el("div", "cc-empty", "Loading…"));
    this.ctx.setTitle();
    try {
      const res = await CC.Servers.of(this.ctx.runtime).host.call("fileText", { cwd: this.cwd(), path: path });
      if (seq !== this.seq || this.disposed) {
        return;
      }
      this.lines = res.lines || [];
      this.draw();
      this.ctx.setTitle();
    } catch (e) {
      if (seq === this.seq && !this.disposed) {
        this.body.replaceChildren(el("div", "cc-empty", "This file couldn't be read: " + (e && e.message ? e.message : e)));
      }
    }
  };

  FileView.prototype.draw = function () {
    if (this.rendered) {
      this.body.replaceChildren(renderMarkdown(this.lines.join("\n"), this.cwd()));
    } else {
      this.drawSource();
    }
    this.find.refresh();
    this.goToLine();
  };

  FileView.prototype.drawSource = function () {
    const self = this;
    const lines = this.lines;
    const box = el("div", "rv-fp-code");
    const shown = Math.min(lines.length, MAX_LINES);
    for (let i = 0; i < shown; i++) {
      const row = el("div", "rv-fp-line");
      row.dataset.line = String(i + 1);
      row.append(el("span", "rv-ln", String(i + 1)), el("span", "rv-code", lines[i]));
      box.appendChild(row);
    }
    this.body.replaceChildren(box);
    if (lines.length === 0) {
      this.body.replaceChildren(el("div", "cc-empty", "This file is empty."));
    } else if (lines.length > shown) {
      this.body.appendChild(el("div", "rv-note", "Showing the first " + shown + " lines of " + lines.length + "."));
    }
    setTimeout(function () {
      if (!self.disposed && self.body.contains(box)) {
        self.paintSource(box, shown);
      }
    }, 0);
  };

  FileView.prototype.paintSource = function (box, shown) {
    const md = CC.markdown;
    if (md == null || md.highlight == null || md.langFromPath == null) {
      return;
    }
    const lang = md.langFromPath(this.params.path);
    if (lang === "") {
      return;
    }
    const lines = this.lines;
    const tokens = D.tokenLines(md.highlight(lines.slice(0, shown).join("\n"), lang));
    box.querySelectorAll(".rv-code").forEach(function (node, i) {
      if (tokens[i] != null) {
        D.paintCode(node, tokens[i], null, lines[i]);
      }
    });
    this.find.refresh();
  };

  FileView.prototype.goToLine = function () {
    const self = this;
    const line = this.params.line;
    const before = this.body.querySelector(".rv-fp-line.is-target");
    if (before != null) {
      before.classList.remove("is-target");
    }
    if (line == null || this.rendered) {
      return;
    }
    const row = this.body.querySelector('.rv-fp-line[data-line="' + Number(line) + '"]');
    if (row == null) {
      return;
    }
    row.classList.add("is-target");
    // The pane may be about to enter the page: the shell mounts first.
    setTimeout(function () {
      if (!self.disposed) {
        self.scroll.scrollTop = Math.max(0, row.offsetTop - self.scroll.clientHeight / 3);
      }
    }, 0);
  };

  function onKey(view, ctx, e) {
    const mod = e.metaKey || e.ctrlKey;
    if (view.find != null && mod && !e.altKey && !e.shiftKey && (e.key || "").toLowerCase() === "f") {
      view.find.open();
      return true;
    }
    if (e.key === "Escape") {
      if (view.find != null && view.find.isOpen()) {
        view.find.close();
      } else {
        ctx.shell.close(ctx.paneId);
      }
      return true;
    }
    return false;
  }

  CC.Panes.register("file", {
    title: function (ctx) {
      return ctx.view != null ? ctx.view.title() : "File";
    },
    actions: function (ctx) {
      return ctx.view != null ? ctx.view.actions() : [];
    },
    mount: function (host, ctx) {
      const view = new FileView(host, ctx);
      return {
        unmount: function () {
          view.dispose();
        },
        onKey: function (e) {
          return onKey(view, ctx, e);
        },
        update: function (params) {
          view.show(params);
        },
      };
    },
  });

  // A path link. {path, line}; chatId and cwd are optional, by default the focused pane's chat. One file pane per chat.
  CC.bus.on("path:open", function (msg) {
    if (msg == null || !msg.path) {
      return;
    }
    const focused = CC.Shell.focused();
    const chatId = msg.chatId !== undefined ? msg.chatId : focused != null ? focused.chatId : null;
    const params = { path: msg.path, line: msg.line != null ? msg.line : null, cwd: msg.cwd || null };
    CC.Shell.open({ kind: "file", chatId: chatId, params: params }, { beside: true });
  });

  function PlanView(host, ctx) {
    this.ctx = ctx;
    ctx.view = this;
    this.seq = 0;
    this.disposed = false;
    this.el = el("div", "rv-fp");
    this.pathEl = el("div", "rv-fp-path");
    this.pathEl.hidden = true;
    this.scroll = el("div", "rv-fp-scroll");
    this.body = el("div", "rv-fp-body");
    this.scroll.appendChild(this.body);
    this.el.append(this.pathEl, this.scroll);
    host.appendChild(this.el);
    this.offs = [];
    const self = this;
    const rt = ctx.runtime;
    if (rt != null && typeof rt.on === "function" && typeof rt.status === "function") {
      let was = rt.status();
      const off = rt.on("state", function () {
        const now = rt.status();
        if ((was === "busy" || was === "waiting") && now !== was) {
          self.load();
        }
        was = now;
      });
      if (typeof off === "function") {
        this.offs.push(off);
      }
    }
    this.load();
  }

  PlanView.prototype.dispose = function () {
    this.disposed = true;
    this.offs.forEach(function (off) {
      off();
    });
  };

  PlanView.prototype.empty = function (text) {
    this.pathEl.hidden = true;
    setPath(this.pathEl, "");
    this.body.replaceChildren(el("div", "cc-empty", text));
  };

  PlanView.prototype.load = async function () {
    const seq = ++this.seq;
    const rt = this.ctx.runtime;
    if (rt == null || typeof rt.control !== "function") {
      this.empty("No plan yet");
      return;
    }
    if (this.body.childElementCount === 0) {
      this.empty("Loading…");
    }
    try {
      const r = await CC.Commands.control(rt, "get_plan");
      if (seq !== this.seq || this.disposed) {
        return;
      }
      if (!r.exists || !r.content) {
        this.empty("No plan yet");
        return;
      }
      this.pathEl.hidden = !r.path;
      setPath(this.pathEl, r.path ? CC.util.shortPath(r.path) : "");
      this.body.replaceChildren(renderMarkdown(r.content, chatCwd(this.ctx)));
    } catch (e) {
      if (seq === this.seq && !this.disposed) {
        this.empty("The plan can't be read while this chat isn't running.");
      }
    }
  };

  CC.Panes.register("plan", {
    title: function () {
      return "Plan";
    },
    actions: function (ctx) {
      return ctx.view == null ? [] : [{ icon: "refresh", label: "Reload the plan", run: function () {
        ctx.view.load();
      } }];
    },
    mount: function (host, ctx) {
      const view = new PlanView(host, ctx);
      return {
        unmount: function () {
          view.dispose();
        },
        onKey: function (e) {
          return onKey(view, ctx, e);
        },
      };
    },
  });
})();
