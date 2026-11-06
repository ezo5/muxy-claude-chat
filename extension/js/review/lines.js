// Review pane, diff column. A file's body is built when it comes near the viewport, with a placeholder of about its height until then, so
// a diff of several hundred files costs one header per file up front. Syntax colours follow later still.
(function () {
  const util = CC.util;
  const el = util.el;
  const D = CC.reviewDiff;
  const R = CC.Review;
  const View = R.View;
  const STEP = 20;
  const ALL = 1e9;
  const ROW_PX = 20;

  View.prototype.fileNode = function (f) {
    const self = this;
    const box = el("div", "rv-file");
    const head = el("div", "rv-file-head");
    head.title = "Collapse or expand (Alt+click: all files)";
    const chev = el("span", "rv-chev");
    chev.appendChild(CC.ui.icon("chevron", 12));
    const name = el("span", "rv-path st-" + f.status, f.status === "renamed" && f.old ? D.baseOf(f.old) + " → " + D.baseOf(f.path) : D.baseOf(f.path));
    name.title = (f.status === "renamed" && f.old ? f.old + " → " : "") + f.path;
    const count = el("span", "rv-ccount");
    const open = CC.ui.iconButton({ icon: "external", label: "Open this file", size: 14, onClick: function (e) {
      e.stopPropagation();
      CC.bus.emit("path:open", { path: (self.root != null ? self.root + "/" : "") + f.path, chatId: self.ctx.chatId, cwd: self.root });
    } });
    open.disabled = f.status === "deleted";
    const mark = el("button", "rv-viewed");
    mark.type = "button";
    mark.addEventListener("click", function (e) {
      e.stopPropagation();
      self.setViewed(f.path, !self.isViewed(f.path));
    });
    head.append(chev, name, el("span", "rv-file-dir", D.dirOf(f.path)), count, CC.ui.numbers(f.add, f.del), mark, open);
    const body = el("div", "rv-file-body");
    box.append(head, body);
    const entry = { f: f, box: box, head: head, body: body, count: count, mark: mark, seen: this.lazy == null, built: false };
    box.ccEntry = entry;
    head.addEventListener("click", function (e) {
      self.headClick(entry, e);
    });
    this.boxes.set(f.path, entry);
    this.updateHeadCount(f.path);
    this.markViewed(entry);
    this.fill(entry);
    if (this.lazy != null) {
      this.lazy.observe(box);
    }
    return box;
  };

  View.prototype.headClick = function (entry, e) {
    const path = entry.f.path;
    if (e.altKey) {
      this.foldAll(!this.collapsed.has(path));
      return;
    }
    const above = this.scroll.scrollTop > entry.box.offsetTop;
    if (this.collapsed.has(path)) {
      this.collapsed.delete(path);
    } else {
      this.collapsed.add(path);
    }
    entry.seen = true;
    this.fill(entry);
    if (above) {
      this.scroll.scrollTop = entry.box.offsetTop;
    }
    this.trackActive();
  };

  View.prototype.markViewed = function (entry) {
    const on = this.isViewed(entry.f.path);
    entry.mark.classList.toggle("is-on", on);
    entry.mark.title = on ? "Viewed. Click to mark as not viewed" : "Mark as viewed";
    entry.mark.setAttribute("aria-label", entry.mark.title);
    entry.mark.setAttribute("aria-pressed", String(on));
    entry.mark.replaceChildren();
    if (on) {
      entry.mark.appendChild(CC.ui.icon("check", 11));
    }
    entry.box.classList.toggle("is-viewed", on);
  };

  // Puts the body in the state collapsed / placeholder / built, from nothing.
  View.prototype.fill = function (entry) {
    const self = this;
    const path = entry.f.path;
    (entry.keys || []).forEach(function (k) {
      self.rows.delete(k);
      self.threads.delete(k);
      self.order.delete(k);
    });
    entry.keys = [];
    const open = !this.collapsed.has(path);
    entry.box.classList.toggle("is-collapsed", !open);
    entry.head.setAttribute("aria-expanded", String(open));
    entry.body.replaceChildren();
    entry.body.hidden = !open;
    entry.built = false;
    entry.body.style.minHeight = open && !entry.seen ? D.rowCount(entry.f, this.opts.split) * ROW_PX + "px" : "";
    this.build(entry);
  };

  View.prototype.build = function (entry) {
    const self = this;
    if (entry.built || !entry.seen || this.collapsed.has(entry.f.path)) {
      return;
    }
    entry.built = true;
    entry.body.style.minHeight = "";
    entry.keys = this.fillBody(entry.f, entry.body);
    setTimeout(function () {
      if (!self.disposed && entry.built && self.boxes.get(entry.f.path) === entry) {
        self.paint(entry);
      }
    }, 0);
    this.find.refresh();
  };

  View.prototype.foldAll = function (fold) {
    const self = this;
    const keep = this.active;
    this.files.forEach(function (f) {
      if (self.collapsed.has(f.path) !== fold) {
        if (fold) {
          self.collapsed.add(f.path);
        } else {
          self.collapsed.delete(f.path);
        }
        self.fill(self.boxes.get(f.path));
      }
    });
    const entry = this.boxes.get(keep);
    if (entry != null) {
      this.scroll.scrollTop = entry.box.offsetTop;
    }
    this.trackActive();
  };

  // A new query opens the files that contain it; files collapsed while searching stay collapsed.
  View.prototype.unfoldMatches = function (needle) {
    const self = this;
    if (needle === this.findNeedle) {
      return;
    }
    this.findNeedle = needle;
    this.files.forEach(function (f) {
      const hit = f.path.toLowerCase().indexOf(needle) >= 0 || f.hunks.some(function (h) {
        return h.lines.some(function (l) {
          return l.toLowerCase().indexOf(needle, 1) >= 0;
        });
      });
      if (!hit) {
        return;
      }
      const entry = self.boxes.get(f.path);
      entry.seen = true;
      if (self.collapsed.has(f.path)) {
        self.collapsed.delete(f.path);
        self.fill(entry);
      } else {
        self.build(entry);
      }
    });
  };

  // --- syntax colours ---

  View.prototype.paint = function (entry) {
    const md = CC.markdown;
    if (md == null || md.highlight == null || md.langFromPath == null || this.collapsed.has(entry.f.path)) {
      return;
    }
    const lang = md.langFromPath(entry.f.path);
    if (lang === "") {
      return;
    }
    const tok = { old: new Map(), new: new Map() };
    const highlight = function (code) {
      return md.highlight(code, lang);
    };
    this.parts(entry.f).forEach(function (p) {
      if (p.hunk != null) {
        D.hunkTokens(p.hunk, highlight, tok);
      }
    });
    entry.body.querySelectorAll(".rv-code").forEach(function (node) {
      const runs = tok[node.hl.side].get(node.hl.line);
      if (runs != null && runs.map(function (r) {
        return r[0];
      }).join("") === node.hl.text) {
        D.paintCode(node, runs, node.hl.segs, node.hl.text);
      }
    });
    this.find.refresh();
  };

  // --- hidden context ---

  View.prototype.expandKey = function (f) {
    return this.src.id + "\n" + f.path;
  };

  View.prototype.parts = function (f) {
    const key = this.expandKey(f);
    return D.viewParts(f, this.expands.get(key) || {}, this.texts.has(key) ? this.texts.get(key).lines || null : null);
  };

  // File text of the diff's new side (working tree, or the commit / range end), fetched once per file.
  View.prototype.fileText = async function (f) {
    const key = this.expandKey(f);
    let entry = this.texts.get(key);
    if (entry == null) {
      const src = this.src;
      const rev = src.commit || (src.range != null ? D.rangeHead(src.range) : null);
      entry = { lines: null, job: CC.Servers.of(this.runtime).host.call("fileText", { cwd: this.cwd(), path: f.path, rev: rev }) };
      this.texts.set(key, entry);
    }
    try {
      const res = await entry.job;
      entry.lines = res.lines || [];
      return entry.lines;
    } catch (e) {
      this.texts.delete(key);
      CC.ui.toast("Can't load " + f.path + ": " + e.message, { level: "error" });
      return null;
    }
  };

  View.prototype.expand = async function (f, gap, side) {
    const src = this.src;
    if (await this.fileText(f) == null || src !== this.src || this.disposed) {
      return;
    }
    const key = this.expandKey(f);
    const ex = this.expands.get(key) || {};
    const e = ex[gap] || { top: 0, bottom: 0 };
    if (side === "all") {
      e.top = ALL;
      e.bottom = ALL;
    } else {
      e[side] += STEP;
    }
    ex[gap] = e;
    this.expands.set(key, ex);
    this.anchorCache.delete(f.path);
    const entry = this.boxes.get(f.path);
    if (entry != null) {
      const top = this.scroll.scrollTop;
      entry.seen = true;
      this.fill(entry);
      this.scroll.scrollTop = top;
    }
    this.renderOrphans();
  };

  // "43 unmodified lines", expandable up, down or at once; "Show more lines" at the end of a file whose length isn't known yet.
  View.prototype.gapRow = function (f, p) {
    const self = this;
    const row = el("div", "rv-hunk");
    const btn = function (icon, label, side) {
      const b = CC.ui.iconButton({ icon: icon, label: label, size: 14, onClick: function (e) {
        e.stopPropagation();
        self.expand(f, p.gap, side);
      } });
      b.classList.add("rv-exp");
      row.appendChild(b);
    };
    if (p.hidden !== 0) {
      const n = p.hidden == null ? STEP : Math.min(STEP, p.hidden);
      if (!p.first && !p.trailing) {
        btn("chevronDown", "Show " + n + " more lines below", "top");
      }
      if (p.trailing) {
        btn("chevronDown", "Show " + n + " more lines", "top");
      } else {
        btn("up", "Show " + n + " more lines above", "bottom");
      }
      if (p.hidden == null || p.hidden > STEP) {
        btn("unfold", p.hidden == null ? "Show the rest of the file" : "Show all " + p.hidden + " unmodified lines", "all");
      }
      row.appendChild(el("span", "rv-hidden", p.hidden == null ? "Show more lines" : D.plural(p.hidden, "unmodified line")));
    }
    if (p.head) {
      row.appendChild(el("span", "rv-hunk-label", p.head));
    }
    return row;
  };

  // --- lines ---

  View.prototype.fillBody = function (f, body) {
    const self = this;
    if (f.binary) {
      body.appendChild(el("div", "rv-note", "Binary file"));
      return [];
    }
    if (f.onlySpace) {
      body.appendChild(el("div", "rv-note", "Only whitespace changed"));
      return [];
    }
    if (f.hunks.length === 0) {
      body.appendChild(el("div", "rv-note", f.truncated ? "Too large to show" : "No content changes"));
      return [];
    }
    const keys = [];
    this.parts(f).forEach(function (part) {
      if (part.hunk == null) {
        if (part.hidden !== 0 || part.head) {
          body.appendChild(self.gapRow(f, part));
        }
        return;
      }
      if (self.opts.split) {
        self.splitLines(f, part.hunk, body, keys);
      } else {
        self.unifiedLines(f, part.hunk, body, keys);
      }
    });
    if (f.truncated) {
      body.appendChild(el("div", "rv-note", "Diff cut short"));
    }
    const drafts = this.drafts != null ? this.drafts.comments : [];
    keys.forEach(function (key) {
      if (drafts.some(function (c) {
        return D.keyOf(c) === key;
      })) {
        self.renderThread(key);
      }
    });
    if (this.picking != null || drafts.some(function (c) {
      return c.from != null;
    })) {
      this.markRanges();
    }
    return keys;
  };

  View.prototype.splitLines = function (f, h, body, keys) {
    const self = this;
    const words = this.opts.words;
    D.splitRows(h).forEach(function (r) {
      const row = el("div", "rv-srow");
      const w = words && r.l != null && r.r != null && r.l.sign === "-" ? D.wordDiff(r.l.code, r.r.code) : null;
      row.append(self.half(f, r.l, r.r, row, "l", keys, w != null ? w[0] : null), self.half(f, r.r, r.r, row, "r", keys, w != null ? w[1] : null));
      body.appendChild(row);
    });
  };

  View.prototype.unifiedLines = function (f, h, body, keys) {
    const self = this;
    const wordsOn = this.opts.words;
    let o = h.o;
    let n = h.n;
    const pairs = D.partners(h.lines);
    const words = new Map();
    h.lines.forEach(function (line, idx) {
      const sign = line.charAt(0);
      const row = el("div", "rv-line" + (sign === "+" ? " add" : sign === "-" ? " del" : ""));
      if (wordsOn && sign === "-" && pairs.has(idx)) {
        const w = D.wordDiff(line.slice(1), h.lines[pairs.get(idx)].slice(1));
        if (w != null) {
          words.set(idx, w[0]);
          words.set(pairs.get(idx), w[1]);
        }
      }
      row.append(el("span", "rv-ln", sign === "+" ? "" : String(o)), el("span", "rv-ln", sign === "-" ? "" : String(n)));
      row.append(el("span", "rv-sign", sign === " " ? "" : sign), D.codeNode(line.slice(1), words.get(idx) || null, sign === "-" ? "old" : "new", sign === "-" ? o : n));
      self.bindLine(f, row, { sign: sign, line: sign === "-" ? o : n, code: line.slice(1) }, row, null, keys);
      body.appendChild(row);
      if (sign !== "+") {
        o += 1;
      }
      if (sign !== "-") {
        n += 1;
      }
    });
  };

  // A context line anchors to its new line number on both sides, like in the unified view.
  View.prototype.half = function (f, cell, right, row, side, keys, segs) {
    if (cell == null) {
      return el("div", "rv-half is-empty");
    }
    const node = el("div", "rv-half" + (cell.sign === "+" ? " add" : cell.sign === "-" ? " del" : ""));
    node.append(el("span", "rv-ln", String(cell.line)), el("span", "rv-sign", cell.sign === " " ? "" : cell.sign), D.codeNode(cell.code, segs, side === "l" ? "old" : "new", cell.line));
    const anchor = cell.sign === " " ? right : cell;
    this.bindLine(f, node, anchor, row, cell.sign === " " ? "r" : side, keys);
    return node;
  };

  // The anchors a file offers, for telling which comments still sit on a line.
  View.prototype.anchorsOf = function (f) {
    let set = this.anchorCache.get(f.path);
    if (set != null) {
      return set;
    }
    set = new Set();
    const src = this.src.id;
    this.parts(f).forEach(function (p) {
      if (p.hunk == null) {
        return;
      }
      D.splitRows(p.hunk).forEach(function (r) {
        if (r.l != null) {
          set.add(D.anchorKey(src, f.path, r.l.sign, r.l.sign === " " ? r.r.line : r.l.line));
        }
        if (r.r != null) {
          set.add(D.anchorKey(src, f.path, r.r.sign, r.r.line));
        }
      });
    });
    this.anchorCache.set(f.path, set);
    return set;
  };
})();
