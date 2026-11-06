// Review pane, right column: checkout picker, file list, and under it the sources that replace the old dropdown.
(function () {
  const util = CC.util;
  const el = util.el;
  const D = CC.reviewDiff;
  const R = CC.Review;
  const View = R.View;
  const STATUS = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U" };
  const GROUPS = [["code", "Changes"], ["test", "Tests"], ["build", "Build"], ["generated", "Generated"]];

  function ago(ts) {
    const when = typeof ts === "number" ? ts : Date.parse(ts);
    if (!when) {
      return "";
    }
    const min = Math.round((Date.now() - when) / 60000);
    if (min < 1) {
      return "now";
    }
    if (min < 60) {
      return min + " min";
    }
    if (min < 1440) {
      return Math.round(min / 60) + " h";
    }
    return Math.round(min / 1440) + " d";
  }

  // The files in list order, which is also the order of the diffs: groups first, folders inside a group.
  View.prototype.ordered = function (files) {
    const opts = this.opts;
    const groupOf = function (f) {
      return opts.separate ? GROUPS.findIndex(function (g) {
        return g[0] === D.fileGroup(f.path);
      }) : 0;
    };
    return files.map(function (f, i) {
      return { f: f, i: i, g: groupOf(f), d: opts.folders ? D.dirOf(f.path) : "" };
    }).sort(function (a, b) {
      return a.g - b.g || a.d.localeCompare(b.d) || a.i - b.i;
    }).map(function (x) {
      return x.f;
    });
  };

  View.prototype.renderSide = function () {
    const self = this;
    const opts = this.opts;
    this.sideHead.replaceChildren(el("span", "rv-side-title", D.plural(this.files.length, "file")));
    this.sideHead.title = this.root || "";
    this.sideList.replaceChildren();
    this.items.clear();
    const frag = document.createDocumentFragment();
    let group = null;
    let folder = null;
    this.files.forEach(function (f) {
      if (opts.separate) {
        const g = D.fileGroup(f.path);
        if (g !== group) {
          group = g;
          folder = null;
          frag.appendChild(el("div", "rv-group", GROUPS.find(function (x) {
            return x[0] === g;
          })[1]));
        }
      }
      if (opts.folders && D.dirOf(f.path) !== folder) {
        folder = D.dirOf(f.path);
        const head = el("div", "rv-folder", folder === "" ? "Top folder" : folder);
        head.title = folder;
        frag.appendChild(head);
      }
      frag.appendChild(self.itemNode(f));
    });
    this.sideList.appendChild(frag);
    if (this.active != null) {
      this.setActive(this.active);
    }
  };

  View.prototype.itemNode = function (f) {
    const self = this;
    const dir = D.dirOf(f.path);
    const item = el("button", "rv-item st-" + f.status);
    item.type = "button";
    item.title = (f.status === "renamed" && f.old ? f.old + " → " : "") + f.path;
    const mark = el("span", "rv-letter", STATUS[f.status] || "M");
    const badge = el("span", "rv-cbadge");
    badge.hidden = true;
    item.append(mark, el("span", "rv-fname", D.baseOf(f.path)));
    item.append(el("span", "rv-dir", this.opts.folders ? "" : D.shortDir(dir)), badge, CC.ui.numbers(f.add, f.del));
    item.addEventListener("click", function () {
      self.reveal(f.path);
      if (self.narrow) {
        self.toggleSide();
      }
    });
    this.items.set(f.path, { root: item, badge: badge, mark: mark, letter: STATUS[f.status] || "M" });
    this.updateItem(f.path);
    return item;
  };

  // Viewed and comment count of one row.
  View.prototype.updateItem = function (path) {
    const item = this.items.get(path);
    if (item == null) {
      return;
    }
    const src = this.src.id;
    const n = this.drafts == null ? 0 : this.drafts.comments.filter(function (c) {
      return c.path === path && (c.src || D.WORKTREE_ID) === src;
    }).length;
    item.badge.textContent = String(n);
    item.badge.title = D.plural(n, "draft comment");
    item.badge.hidden = n === 0;
    const viewed = this.isViewed(path);
    item.root.classList.toggle("is-viewed", viewed);
    item.mark.replaceChildren(viewed ? CC.ui.icon("check", 12) : document.createTextNode(item.letter));
  };

  View.prototype.sideKey = function (e) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const paths = this.files.map(function (f) {
      return f.path;
    });
    const i = paths.indexOf(this.active);
    const next = paths[Math.max(0, Math.min(paths.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next != null) {
      this.reveal(next);
    }
  };

  View.prototype.reveal = function (path) {
    const entry = this.boxes.get(path);
    if (entry == null) {
      return;
    }
    entry.seen = true;
    if (this.collapsed.has(path)) {
      this.collapsed.delete(path);
      this.fill(entry);
    } else {
      this.build(entry);
    }
    this.scroll.scrollTop = entry.box.offsetTop;
    this.setActive(path);
  };

  View.prototype.trackActive = function () {
    let current = null;
    const top = this.scroll.scrollTop + 24;
    for (let i = 0; i < this.files.length; i++) {
      const entry = this.boxes.get(this.files[i].path);
      if (entry == null) {
        continue;
      }
      if (current != null && entry.box.offsetTop > top) {
        break;
      }
      current = entry;
    }
    if (current == null) {
      return;
    }
    if (current.f.path !== this.active) {
      this.setActive(current.f.path);
    }
    const stuck = !this.collapsed.has(current.f.path) && this.scroll.scrollTop > current.box.offsetTop ? current.box : null;
    if (stuck !== this.stuck) {
      if (this.stuck != null) {
        this.stuck.classList.remove("is-stuck");
      }
      if (stuck != null) {
        stuck.classList.add("is-stuck");
      }
      this.stuck = stuck;
    }
  };

  View.prototype.setActive = function (path) {
    const prev = this.items.get(this.active);
    if (prev != null) {
      prev.root.classList.remove("is-active");
    }
    this.active = path;
    const item = this.items.get(path);
    if (item != null) {
      item.root.classList.add("is-active");
      if (item.root.scrollIntoView != null) {
        item.root.scrollIntoView({ block: "nearest" });
      }
    }
  };

  // Hidden while the repo has a single checkout.
  View.prototype.renderCheckout = function () {
    const self = this;
    const worktrees = (this.sources || {}).worktrees || [];
    this.checkoutRow.hidden = worktrees.length < 2;
    if (worktrees.length < 2) {
      this.checkoutRow.replaceChildren();
      return;
    }
    const nameOf = function (w) {
      return w.path.replace(/\/+$/, "").split("/").pop() + (w.branch != null ? " · " + w.branch : "");
    };
    const root = this.root;
    const current = worktrees.find(function (w) {
      return w.path === root;
    });
    const btn = el("button", "rv-checkout-btn");
    btn.type = "button";
    btn.title = "Which checkout: main or a worktree";
    btn.append(CC.ui.icon("branch", 14), el("span", "rv-checkout-name", current != null ? nameOf(current) : root), CC.ui.icon("chevronDown", 12));
    btn.addEventListener("click", function () {
      CC.ui.menu(worktrees.map(function (w) {
        return { label: nameOf(w), icon: w.path === root ? "check" : "none", run: function () {
          if (w.path !== root) {
            self.setCheckout(w.path);
          }
        } };
      }), { anchor: btn });
    });
    this.checkoutRow.replaceChildren(btn);
  };

  View.prototype.sourceRow = function (src, title, meta) {
    const self = this;
    const row = el("button", "rv-src" + (src.id === this.src.id ? " is-active" : ""));
    row.type = "button";
    row.title = title;
    row.append(el("span", "rv-src-title", title));
    if (meta) {
      row.appendChild(el("span", "rv-src-meta", meta));
    }
    row.addEventListener("click", function () {
      if (src.id !== self.src.id) {
        self.setSource(src);
      }
      if (self.narrow) {
        self.toggleSide();
      }
    });
    return row;
  };

  View.prototype.rangeRow = function (body) {
    const self = this;
    const row = el("button", "rv-src rv-src-quiet", "Commit range…");
    row.type = "button";
    row.addEventListener("click", function () {
      const input = el("input", "rv-range");
      input.type = "text";
      input.placeholder = "master..HEAD";
      input.spellcheck = false;
      input.setAttribute("aria-label", "Commit range");
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && input.value.trim() !== "") {
          e.preventDefault();
          self.setSource(R.rangeSource(input.value.trim()));
        } else if (e.key === "Escape") {
          e.preventDefault();
          input.replaceWith(row);
        }
      });
      row.replaceWith(input);
      input.focus();
    });
    body.appendChild(row);
  };

  // "All changes" and "Uncommitted changes", Claude's turns, then the commits.
  View.prototype.renderSources = function () {
    const self = this;
    const res = this.sources || {};
    const body = el("div", "rv-sources-body");
    const head = el("button", "rv-sources-head");
    head.type = "button";
    head.append(el("span", null, "Commits"), CC.ui.icon(this.opts.sources ? "chevronDown" : "chevron", 12));
    head.setAttribute("aria-expanded", String(this.opts.sources));
    head.addEventListener("click", function () {
      self.opts.sources = !self.opts.sources;
      self.saveOptions();
      self.renderSources();
    });
    body.hidden = !this.opts.sources;
    const known = new Set();
    const add = function (src, title, meta) {
      known.add(src.id);
      body.appendChild(self.sourceRow(src, title, meta));
    };
    if (res.base != null) {
      add(R.baseSource(res.base), "All changes", "against " + res.base);
    }
    add(R.WORKTREE, "Uncommitted changes");
    if (!known.has(this.src.id) && this.src.kind === "base") {
      add(this.src, "All changes");
    }
    const turns = R.turnSources(this.store(), res);
    if (turns.length > 0) {
      const inTurn = this.src.kind === "turn";
      body.appendChild(CC.ui.disclosure({
        label: "Claude's edits in a turn",
        open: inTurn,
        body: function (host) {
          turns.forEach(function (t) {
            known.add(t.id);
            host.appendChild(self.sourceRow(t, util.firstLine(t.text, 80), ago(t.ts)));
          });
        },
      }));
    }
    (res.commits || []).forEach(function (c) {
      add(R.commitSource(c.sha, c.short, c.subject), c.subject, c.short + (ago(c.ts) ? " · " + ago(c.ts) : ""));
    });
    if (!known.has(this.src.id) && (this.src.kind === "commit" || this.src.kind === "range")) {
      add(this.src, this.src.range || this.src.short);
    }
    this.rangeRow(body);
    this.sourcesEl.replaceChildren(head, body);
    this.sourcesEl.classList.toggle("is-open", this.opts.sources);
  };
})();
