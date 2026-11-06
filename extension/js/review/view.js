// One Review pane: a diff of a source in a checkout, the file list on the right, comments going to Claude as one message. All state is on
// the instance and every query stays inside its own element, so panes never share anything but what kv says about a checkout.
// The prototype continues in list.js (file list, sources), lines.js (diff bodies) and comments.js.
CC.Review.View = (function () {
  const util = CC.util;
  const el = util.el;
  const D = CC.reviewDiff;
  const R = CC.Review;
  const NARROW_PX = 640;
  const REFRESH_DELAY_MS = 400;
  const SIDE_WIDTH = 280;
  const DEFAULTS = { side: true, width: SIDE_WIDTH, sources: true, folders: false, separate: false, split: false, wrap: false, words: true, hideWs: false };

  function View(host, ctx) {
    const self = this;
    this.ctx = ctx;
    ctx.view = this;
    this.runtime = ctx.runtime;
    this.opts = Object.assign({}, DEFAULTS);
    this.src = R.fromParams(ctx.params);
    this.checkout = ctx.params.checkout || null;
    this.picked = this.checkout != null;
    this.startSeq = 0;
    this.sources = null;
    this.root = null;
    this.drafts = null;
    this.raw = [];
    this.files = [];
    this.truncated = false;
    this.notice = null;
    this.loading = false;
    this.disposed = false;
    this.narrow = false;
    this.sideShown = true;
    this.collapsed = new Set();
    this.autoFolded = new Set();
    this.boxes = new Map();
    this.items = new Map();
    this.rows = new Map();
    this.threads = new Map();
    this.order = new Map();
    this.seq = 0;
    this.anchorCache = new Map();
    this.expands = new Map();
    this.texts = new Map();
    this.active = null;
    this.stuck = null;
    this.pick = null;
    this.picking = null;
    this.findNeedle = "";
    this.pendingPath = ctx.params.path || null;
    this.offs = [];

    this.el = el("div", "rv");
    this.bar = el("div", "rv-bar");
    this.summary = el("span", "rv-summary");
    this.sendBtn = CC.ui.button({ label: "Send comments", primary: true, onClick: function () {
      self.send();
    } });
    this.sendBtn.title = "Send all comments to Claude as one message";
    this.sendBtn.hidden = true;
    this.bar.append(this.summary, this.sendBtn);

    this.orphans = el("div", "rv-orphans");
    this.orphans.hidden = true;
    this.list = el("div", "rv-files");
    this.scroll = el("div", "rv-scroll");
    this.scroll.append(this.orphans, this.list);
    let ticking = false;
    this.scroll.addEventListener("scroll", function () {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(function () {
          ticking = false;
          if (!self.disposed) {
            self.trackActive();
          }
        });
      }
    });

    this.side = el("aside", "rv-side");
    this.side.setAttribute("aria-label", "Changed files");
    const grip = el("div", "rv-grip");
    grip.addEventListener("pointerdown", function (e) {
      self.resize(e, grip);
    });
    this.checkoutRow = el("div", "rv-checkout");
    this.checkoutRow.hidden = true;
    this.sideHead = el("div", "rv-side-head");
    this.sideList = el("div", "rv-side-list");
    this.sideList.tabIndex = 0;
    this.sideList.addEventListener("keydown", function (e) {
      self.sideKey(e);
    });
    this.sourcesEl = el("div", "rv-sources");
    this.side.append(grip, this.checkoutRow, this.sideHead, this.sideList, this.sourcesEl);

    this.main = el("div", "rv-main");
    this.main.append(this.scroll, this.side);
    this.el.append(this.bar);
    this.find = new CC.ReviewFind({
      scroller: this.scroll,
      root: this.list,
      mount: this.el,
      roots: ".rv-code, .rv-path",
      placeholder: "Find in changes",
      prepare: function (needle) {
        self.unfoldMatches(needle);
      },
    });
    this.el.append(this.main);
    host.appendChild(this.el);

    if (typeof IntersectionObserver === "function") {
      this.lazy = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            self.lazy.unobserve(e.target);
            e.target.ccEntry.seen = true;
            self.build(e.target.ccEntry);
          }
        });
      }, { root: this.scroll, rootMargin: "1000px 0px" });
    } else {
      this.lazy = null;
    }
    if (typeof ResizeObserver === "function") {
      this.resizer = new ResizeObserver(function () {
        self.setNarrow(self.el.clientWidth > 0 && self.el.clientWidth < NARROW_PX);
      });
      this.resizer.observe(this.el);
    } else {
      this.resizer = null;
    }
    this.offs.push(CC.bus.on("review:drafts", function (msg) {
      self.draftsChanged(msg);
    }));
    this.listenToChat();
    this.showEmpty("Loading the diff…");
    this.boot();
  }

  View.prototype.boot = async function () {
    const saved = await CC.Servers.appKv().get("ui", "review").catch(function () {
      return null;
    });
    if (this.disposed) {
      return;
    }
    if (saved != null && typeof saved === "object") {
      Object.assign(this.opts, saved);
    }
    this.side.style.width = this.opts.width + "px";
    this.applyLayout();
    await this.start();
  };

  View.prototype.dispose = function () {
    this.disposed = true;
    clearTimeout(this.refreshTimer);
    this.find.dispose();
    if (this.lazy != null) {
      this.lazy.disconnect();
    }
    if (this.resizer != null) {
      this.resizer.disconnect();
    }
    this.offs.forEach(function (off) {
      off();
    });
  };

  // While the pane is open, a finished turn refreshes what it shows. Text being typed in a comment is never thrown away for that.
  View.prototype.listenToChat = function () {
    const self = this;
    const rt = this.runtime;
    if (rt == null || typeof rt.on !== "function" || typeof rt.status !== "function") {
      return;
    }
    let was = rt.status();
    this.offs.push(rt.on("state", function () {
      const now = rt.status();
      const finished = (was === "busy" || was === "waiting") && now !== was;
      was = now;
      if (finished) {
        clearTimeout(self.refreshTimer);
        self.refreshTimer = setTimeout(function () {
          self.autoRefresh();
        }, REFRESH_DELAY_MS);
      }
    }) || function () {});
  };

  View.prototype.autoRefresh = function () {
    const typing = Array.from(this.scroll.querySelectorAll(".rv-input")).some(function (t) {
      return t.value.trim() !== "";
    });
    if (!this.disposed && !typing && this.src.kind !== "commit" && this.src.kind !== "range") {
      this.start();
    }
  };

  View.prototype.store = function () {
    return this.runtime != null ? this.runtime.store : null;
  };

  View.prototype.chatCwd = function () {
    const rt = this.runtime;
    const meta = rt != null && typeof rt.meta === "function" ? rt.meta() : null;
    if (meta != null && meta.cwd) {
      return meta.cwd;
    }
    const row = this.ctx.chatId != null && CC.Chats != null ? CC.Chats.get(this.ctx.chatId) : null;
    return row != null && row.cwd ? row.cwd : null;
  };

  View.prototype.cwd = function () {
    return this.checkout || this.chatCwd() || ".";
  };

  View.prototype.transcript = function () {
    const rt = this.runtime;
    return rt != null && typeof rt.transcriptFile === "function" ? rt.transcriptFile() : null;
  };

  // --- loading ---

  View.prototype.start = async function () {
    const seq = ++this.startSeq;
    try {
      await this.loadSources(seq);
      if (seq === this.startSeq && !this.disposed) {
        await this.load();
      }
    } catch (e) {
      console.error("review", e);
      if (seq === this.startSeq && !this.disposed) {
        this.showEmpty("This diff couldn't be shown: " + (e && e.message ? e.message : e));
      }
    }
  };

  View.prototype.loadSources = async function (seq) {
    let reply = { turns: [], commits: [] };
    try {
      reply = await CC.Servers.of(this.runtime).host.call("reviewSources", { cwd: this.cwd(), file: this.transcript() });
    } catch (e) {
      console.warn("review sources failed", e && e.message);
    }
    if (seq !== this.startSeq || this.disposed) {
      return;
    }
    this.sources = reply;
    const root = reply.root || this.cwd();
    if (!this.picked) {
      this.picked = true;
      const wt = this.src.kind === "uncommitted" ? R.editedWorktree(this.store(), reply.worktrees) : null;
      if (wt != null && wt !== root) {
        this.checkout = wt;
        await this.loadSources(seq);
        return;
      }
    }
    this.root = root;
    this.resolveSource();
    await this.loadDrafts(root);
    if (seq !== this.startSeq || this.disposed) {
      return;
    }
    this.renderCheckout();
    this.renderSources();
    this.ctx.setTitle();
  };

  // A source from params knows only its id; the lists know its text.
  View.prototype.resolveSource = function () {
    const src = this.src;
    const res = this.sources || {};
    if (src.kind === "base" && src.base == null && res.base != null) {
      this.src = R.baseSource(res.base);
    } else if (src.kind === "turn") {
      const t = R.turnSources(this.store(), res).find(function (x) {
        return x.id === src.id;
      });
      this.src = t || src;
    } else if (src.kind === "commit") {
      const c = (res.commits || []).find(function (x) {
        return x.sha === src.commit || x.short === src.commit;
      });
      this.src = c != null ? R.commitSource(c.sha, c.short, c.subject) : src;
    }
  };

  View.prototype.loadDrafts = async function (root) {
    const next = new CC.ReviewDrafts(root, CC.Servers.of(this.runtime));
    if (this.drafts != null && this.drafts.scope === next.scope) {
      return;
    }
    try {
      await next.load();
    } catch (e) {
      console.warn("review drafts not loaded:", e && e.message);
    }
    this.drafts = next;
    this.updateCount();
  };

  View.prototype.load = async function () {
    if (this.loading) {
      this.loadAgain = true;
      return;
    }
    this.loading = true;
    this.loadAgain = false;
    this.resolveSource();
    const src = this.src;
    try {
      const res = await this.fetchDiff(src);
      if (src === this.src && !this.disposed) {
        this.notice = res.error || null;
        this.raw = res.error ? [] : res.files || [];
        this.truncated = res.truncated === true;
        this.root = res.root || this.root;
        this.expands.clear();
        this.texts.clear();
        this.render(true);
      }
    } catch (e) {
      if (src === this.src && !this.disposed) {
        this.raw = [];
        this.notice = "The diff couldn't be read: " + (e && e.message ? e.message : e);
        this.render(true);
      }
    } finally {
      this.loading = false;
    }
    if (!this.disposed && (src !== this.src || this.loadAgain)) {
      await this.load();
    }
  };

  View.prototype.fetchDiff = function (src) {
    if (src.kind === "base" && src.base == null) {
      return Promise.resolve({ error: "This checkout has no master or main branch to compare with." });
    }
    if (src.kind === "turn" && src.files != null) {
      return Promise.resolve({ root: this.root, files: src.files });
    }
    if (src.kind === "turn" && this.transcript() == null) {
      return Promise.resolve({ error: "This turn isn't in the chat's history any more." });
    }
    return CC.Servers.of(this.runtime).host.call("diff", {
      cwd: this.cwd(), turn: src.turn, file: src.kind === "turn" ? this.transcript() : null, commit: src.commit, range: src.range, base: src.base,
    });
  };

  View.prototype.refresh = function () {
    this.start();
  };

  // A source picked inside the pane. `update` below is the same from outside.
  View.prototype.setSource = function (src) {
    this.src = src;
    this.raw = [];
    this.collapsed.clear();
    this.autoFolded.clear();
    this.rememberParams();
    this.renderSources();
    this.ctx.setTitle();
    this.showEmpty("Loading the diff…");
    this.load();
  };

  View.prototype.setCheckout = function (path) {
    this.checkout = path;
    this.picked = true;
    this.src = R.WORKTREE;
    this.raw = [];
    this.collapsed.clear();
    this.autoFolded.clear();
    this.rememberParams();
    this.showEmpty("Loading the diff…");
    this.start();
  };

  // Opened again with other params: another source, checkout or file to show.
  View.prototype.update = function (params) {
    const p = params || {};
    const checkout = p.checkout || null;
    const next = R.fromParams(p);
    this.pendingPath = p.path || null;
    if (checkout != null && checkout !== this.checkout) {
      this.checkout = checkout;
      this.picked = true;
      this.src = next;
      this.raw = [];
      this.rememberParams();
      this.showEmpty("Loading the diff…");
      this.start();
    } else if (next.id !== this.src.id) {
      this.setSource(next);
    } else if (this.pendingPath != null) {
      this.revealPending();
    }
  };

  // The shell saves params in the layout, so a reload comes back to the same diff.
  View.prototype.rememberParams = function () {
    const params = Object.assign({}, R.toParams(this.src));
    if (this.checkout != null) {
      params.checkout = this.checkout;
    }
    if (this.ctx.setParams != null) {
      this.ctx.setParams(params);
    } else {
      this.ctx.params = params;
    }
  };

  // --- pane chrome ---

  View.prototype.branch = function () {
    const root = this.root;
    const row = ((this.sources || {}).worktrees || []).find(function (w) {
      return w.path === root;
    });
    return row != null && row.branch != null ? row.branch : "HEAD";
  };

  View.prototype.title = function () {
    const src = this.src;
    if (src.kind === "base") {
      return src.base != null ? src.base + " → " + this.branch() : "Branch changes";
    }
    if (src.kind === "turn") {
      return "Turn: " + (src.text ? util.firstLine(src.text, 60) : "Claude's edits");
    }
    if (src.kind === "commit") {
      return src.short + (src.subject ? " " + src.subject : "");
    }
    if (src.kind === "range") {
      return src.range;
    }
    return this.branch() + " · uncommitted";
  };

  View.prototype.actions = function () {
    const self = this;
    return [
      { icon: "search", label: "Find in changes", run: function () {
        self.find.open();
      } },
      { icon: "list", label: "Show or hide files", on: this.sideShown, run: function () {
        self.toggleSide();
      } },
      { icon: "gear", label: "View options", run: function (e) {
        self.showMenu(e.currentTarget);
      } },
    ];
  };

  View.prototype.showMenu = function (anchor) {
    const self = this;
    const o = this.opts;
    const toggle = function (label, key, disabled) {
      return { label: label, icon: o[key] ? "check" : "none", disabled: disabled === true, run: function () {
        self.setOption(key, !o[key]);
      } };
    };
    CC.ui.menu([
      { label: "Show files", icon: this.sideShown ? "check" : "none", run: function () {
        self.toggleSide();
      } },
      toggle("Group files by folder", "folders"),
      toggle("Separate test, build and generated", "separate"),
      { separator: true },
      { label: "Collapse all", icon: "fold", run: function () {
        self.foldAll(true);
      } },
      { label: "Expand all", icon: "unfold", run: function () {
        self.foldAll(false);
      } },
      { separator: true },
      toggle("Side by side", "split"),
      toggle("Word wrap", "wrap", o.split),
      toggle("Highlight changed words", "words"),
      toggle("Hide whitespace changes", "hideWs"),
      { separator: true },
      { label: "Refresh", icon: "refresh", run: function () {
        self.refresh();
      } },
      { label: "Settings…", run: function () {
        CC.SettingsView.open();
      } },
    ], { anchor: anchor });
  };

  View.prototype.saveOptions = function () {
    CC.Servers.appKv().set("ui", "review", this.opts).catch(function (e) {
      console.warn("review options not saved:", e && e.message);
    });
  };

  View.prototype.setOption = function (key, value) {
    this.opts[key] = value;
    this.saveOptions();
    this.applyLayout();
    if (key === "hideWs") {
      this.expands.clear();
    }
    if (key === "wrap") {
      return;
    }
    const keep = this.active;
    this.render(false);
    if (keep != null) {
      this.reveal(keep);
    }
  };

  View.prototype.applyLayout = function () {
    this.el.classList.toggle("is-split", this.opts.split);
    this.el.classList.toggle("is-wrap", this.opts.wrap);
    this.el.classList.toggle("is-narrow", this.narrow);
    this.side.hidden = !(this.narrow ? this.sideShown : this.opts.side);
    this.sideShown = !this.side.hidden;
    this.ctx.setTitle();
  };

  View.prototype.toggleSide = function () {
    this.sideShown = !this.sideShown;
    if (!this.narrow) {
      this.opts.side = this.sideShown;
      this.saveOptions();
    }
    this.side.hidden = !this.sideShown;
    if (this.sideShown && this.active != null) {
      this.setActive(this.active);
    }
    this.ctx.setTitle();
  };

  // Too narrow for two columns: the list floats over the diff and starts closed.
  View.prototype.setNarrow = function (narrow) {
    if (narrow === this.narrow) {
      return;
    }
    this.narrow = narrow;
    this.sideShown = false;
    this.applyLayout();
  };

  View.prototype.resize = function (e, grip) {
    const self = this;
    const startX = e.clientX;
    const startW = this.side.offsetWidth;
    grip.setPointerCapture(e.pointerId);
    this.el.classList.add("is-resizing");
    const move = function (ev) {
      self.side.style.width = Math.max(180, Math.min(560, startW + startX - ev.clientX)) + "px";
    };
    const up = function () {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      self.el.classList.remove("is-resizing");
      self.opts.width = self.side.offsetWidth;
      self.saveOptions();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    e.preventDefault();
  };

  View.prototype.onKey = function (e) {
    const mod = e.metaKey || e.ctrlKey;
    const key = (e.key || "").toLowerCase();
    if (mod && !e.altKey && !e.shiftKey && key === "f") {
      this.find.open();
      return true;
    }
    if (mod && e.shiftKey && !e.altKey && key === "y") {
      this.toggleSide();
      return true;
    }
    if (e.key === "Escape") {
      if (this.find.isOpen()) {
        this.find.close();
      } else {
        this.ctx.shell.close(this.ctx.paneId);
      }
      return true;
    }
    return false;
  };

  // --- render ---

  View.prototype.showEmpty = function (text) {
    this.files = [];
    this.boxes.clear();
    this.items.clear();
    this.list.replaceChildren(el("div", "cc-empty", text));
    this.summary.replaceChildren();
    this.sideHead.replaceChildren();
    this.sideList.replaceChildren();
    this.renderOrphans();
  };

  // First pass after a load folds what is marked viewed; a viewed mark whose diff changed is gone for good.
  View.prototype.applyViewed = function () {
    const self = this;
    if (this.drafts == null) {
      return;
    }
    let dirty = false;
    this.raw.forEach(function (f) {
      const stored = self.drafts.storedViewed(self.src.id, f.path);
      if (stored != null && stored !== self.sigOf(f)) {
        self.drafts.setViewed(self.src.id, f.path, null);
        dirty = true;
      }
      if (stored != null && stored === self.sigOf(f)) {
        if (!self.autoFolded.has(f.path)) {
          self.collapsed.add(f.path);
          self.autoFolded.add(f.path);
        }
      } else if (self.autoFolded.has(f.path)) {
        self.autoFolded.delete(f.path);
        self.collapsed.delete(f.path);
      }
    });
    if (dirty) {
      this.drafts.saveViewed();
    }
  };

  View.prototype.sigOf = function (f) {
    if (f.sig == null) {
      f.sig = D.signature(f);
    }
    return f.sig;
  };

  View.prototype.rawOf = function (path) {
    return this.raw.find(function (f) {
      return f.path === path;
    }) || null;
  };

  View.prototype.isViewed = function (path) {
    if (this.drafts == null) {
      return false;
    }
    const stored = this.drafts.storedViewed(this.src.id, path);
    const f = stored != null ? this.rawOf(path) : null;
    return f != null && stored === this.sigOf(f);
  };

  View.prototype.setViewed = function (path, on) {
    const f = this.rawOf(path);
    if (f == null || this.drafts == null) {
      return;
    }
    this.drafts.setViewed(this.src.id, path, on ? this.sigOf(f) : null);
    this.drafts.saveViewed();
    if (on) {
      this.collapsed.add(path);
      this.autoFolded.add(path);
    } else {
      this.collapsed.delete(path);
      this.autoFolded.delete(path);
    }
    const entry = this.boxes.get(path);
    if (entry != null) {
      const above = this.scroll.scrollTop > entry.box.offsetTop;
      this.fill(entry);
      this.markViewed(entry);
      if (above) {
        this.scroll.scrollTop = entry.box.offsetTop;
      }
    }
    this.updateItem(path);
    this.renderSummary();
  };

  View.prototype.render = function (fresh) {
    const self = this;
    if (this.notice != null) {
      this.showEmpty(this.notice);
      return;
    }
    if (fresh) {
      this.applyViewed();
    }
    const top = this.scroll.scrollTop;
    this.rows.clear();
    this.threads.clear();
    this.order.clear();
    this.anchorCache.clear();
    this.boxes.clear();
    this.seq = 0;
    this.pick = null;
    this.stuck = null;
    const shown = this.opts.hideWs ? this.raw.map(D.stripWhitespace) : this.raw;
    this.files = this.ordered(shown);
    if (this.files.length === 0) {
      const src = this.src;
      this.showEmpty(src.kind === "uncommitted" ? "No uncommitted changes." : src.kind === "base" ? "No changes against " + src.base + "." : "No changes.");
      return;
    }
    if (this.lazy != null) {
      this.lazy.disconnect();
    }
    this.list.replaceChildren();
    const frag = document.createDocumentFragment();
    this.files.forEach(function (f) {
      frag.appendChild(self.fileNode(f));
    });
    this.list.appendChild(frag);
    this.renderSide();
    this.renderSummary();
    this.renderOrphans();
    this.scroll.scrollTop = top;
    this.trackActive();
    this.revealPending();
    this.find.refresh();
  };

  View.prototype.revealPending = function () {
    if (this.pendingPath != null && this.boxes.has(this.pendingPath)) {
      this.reveal(this.pendingPath);
      this.pendingPath = null;
    }
  };

  View.prototype.renderSummary = function () {
    const self = this;
    let add = 0;
    let del = 0;
    let viewed = 0;
    this.files.forEach(function (f) {
      add += f.add;
      del += f.del;
      viewed += self.isViewed(f.path) ? 1 : 0;
    });
    const parts = [el("span", null, D.plural(this.files.length, "file")), CC.ui.numbers(add, del)];
    if (viewed > 0) {
      parts.push(el("span", null, viewed + " of " + this.files.length + " viewed"));
    }
    if (this.truncated) {
      parts.push(el("span", null, "cut short, the diff is too large"));
    }
    this.summary.replaceChildren.apply(this.summary, parts);
    this.summary.title = this.root || "";
  };

  return View;
})();
