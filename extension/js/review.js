window.CC = window.CC || {};

// Diff of the working tree, the branch against its base, one of Claude's turns, a commit or a commit range; comments
// on a line or a line range are kept as drafts and go to Claude as one prompt.
CC.Review = (function () {
  const util = CC.util;
  const el = util.el;
  const STATUS = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U" };
  const NARROW = "(max-width: 640px)";
  const WORKTREE = { id: "worktree", label: "the uncommitted changes" };
  const STEP = 20;
  const ALL = 1e9;

  function anchorKey(src, path, sign, line) {
    return src + "\n" + path + "\n" + sign + line;
  }

  function keyOf(c) {
    return anchorKey(c.src || WORKTREE.id, c.path, c.sign, c.line);
  }

  function pathOfKey(key) {
    return key.split("\n")[1];
  }

  // Changed words of a paired removed / added line, or null when the lines have too little in common.
  function wordDiff(a, b) {
    const x = a.match(/\w+|\s+|[^\w\s]/g) || [];
    const y = b.match(/\w+|\s+|[^\w\s]/g) || [];
    if (x.length * y.length > 40000 || x.length === 0 || y.length === 0) {
      return null;
    }
    const t = [];
    for (let i = x.length; i >= 0; i--) {
      t[i] = new Uint16Array(y.length + 1);
      for (let j = y.length - 1; i < x.length && j >= 0; j--) {
        t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
      }
    }
    const sa = [];
    const sb = [];
    let same = 0;
    let i = 0;
    let j = 0;
    const push = function (segs, text, changed) {
      const last = segs[segs.length - 1];
      if (last != null && last[1] === changed) {
        last[0] += text;
      } else {
        segs.push([text, changed]);
      }
    };
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        same += x[i].trim() === "" ? 0 : x[i].length;
        push(sa, x[i++], false);
        push(sb, y[j++], false);
      } else if (i < x.length && (j >= y.length || t[i + 1][j] >= t[i][j + 1])) {
        push(sa, x[i++], true);
      } else {
        push(sb, y[j++], true);
      }
    }
    return same * 4 < Math.max(a.trim().length, b.trim().length) ? null : [sa, sb];
  }

  // `side` / `line` say where paint() finds the line's syntax tokens.
  function codeNode(text, segs, side, line) {
    const node = el("span", "rv-code");
    node.hl = { side: side, line: line, segs: segs, text: text };
    if (segs == null) {
      node.textContent = text;
      return node;
    }
    segs.forEach(function (sg) {
      node.appendChild(sg[1] ? el("span", "rv-word", sg[0]) : document.createTextNode(sg[0]));
    });
    return node;
  }

  // highlight.js output split into lines of [text, class of the nearest span] runs.
  function tokenLines(code, lang) {
    const tpl = document.createElement("template");
    tpl.innerHTML = CC.markdown.highlight(code, lang);
    const lines = [[]];
    const walk = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t != null; t = walk.nextNode()) {
      const cls = t.parentNode.nodeType === 1 ? t.parentNode.className : "";
      t.data.split("\n").forEach(function (s, i) {
        if (i > 0) {
          lines.push([]);
        }
        if (s !== "") {
          lines[lines.length - 1].push([s, cls]);
        }
      });
    }
    return lines;
  }

  // Each side of a hunk is highlighted as one text, so comments and strings spanning lines come out right.
  function hunkTokens(h, lang, tok) {
    const old = [];
    const neu = [];
    h.lines.forEach(function (l) {
      if (l.charAt(0) !== "+") {
        old.push(l.slice(1));
      }
      if (l.charAt(0) !== "-") {
        neu.push(l.slice(1));
      }
    });
    tokenLines(old.join("\n"), lang).forEach(function (runs, i) {
      tok.old.set(h.o + i, runs);
    });
    tokenLines(neu.join("\n"), lang).forEach(function (runs, i) {
      tok.new.set(h.n + i, runs);
    });
  }

  // Token runs nested inside the word-diff segments.
  function paintCode(node, runs, segs) {
    node.textContent = "";
    let ri = 0;
    let off = 0;
    (segs || [[node.hl.text, false]]).forEach(function (sg) {
      const host = sg[1] ? node.appendChild(el("span", "rv-word")) : node;
      let left = sg[0].length;
      while (left > 0 && ri < runs.length) {
        const run = runs[ri];
        const take = Math.min(left, run[0].length - off);
        const piece = run[0].substr(off, take);
        host.appendChild(run[1] !== "" ? el("span", run[1], piece) : document.createTextNode(piece));
        left -= take;
        off += take;
        if (off === run[0].length) {
          ri++;
          off = 0;
        }
      }
    });
  }

  function newCount(h) {
    let n = 0;
    h.lines.forEach(function (l) {
      if (l.charAt(0) !== "-") {
        n++;
      }
    });
    return n;
  }

  // The new side of a commit range ("A..B", "A...B", "A.." = A..HEAD); a single revision is diffed against the
  // working tree.
  function rangeHead(range) {
    const m = range.split(/\.\.\.?/);
    return m.length > 1 ? m[1] || "HEAD" : null;
  }

  // Hunks with the context lines expanded so far (`ex`: per gap {top, bottom}; gap i is above hunk i, the last one
  // below the last hunk), and the gaps that still hide lines. Context lines are the same on both sides, so they come
  // from the new side's text and old line numbers follow from the hunk offsets.
  function viewParts(f, ex, text) {
    const parts = [];
    const expandable = !f.binary && f.hunks.length > 0 && !/^(added|untracked|deleted)$/.test(f.status);
    let prev = null;
    let prevEnd = 0;
    f.hunks.forEach(function (h, i) {
      const e = ex[i] || { top: 0, bottom: 0 };
      const from = prevEnd + 1;
      const to = h.n - 1;
      const size = expandable ? to - from + 1 : 0;
      let cur = { o: h.o, n: h.n, head: h.head, lines: h.lines.slice() };
      let hidden = Math.max(0, size);
      if (size > 0 && text != null) {
        const top = prev != null ? Math.min(e.top, size) : 0;
        const bottom = Math.min(e.bottom, size - top);
        for (let k = 0; k < top; k++) {
          prev.lines.push(" " + (text[from - 1 + k] || ""));
        }
        const pre = [];
        for (let k = to - bottom + 1; k <= to; k++) {
          pre.push(" " + (text[k - 1] || ""));
        }
        cur.lines = pre.concat(cur.lines);
        cur.o -= bottom;
        cur.n -= bottom;
        hidden = size - top - bottom;
        if (hidden === 0 && prev != null) {
          prev.lines = prev.lines.concat(cur.lines);
          cur = null;
        }
      }
      if (cur != null) {
        parts.push({ gap: i, hidden: hidden, first: prev == null, head: { o: cur.o, n: cur.n, head: h.head } });
        parts.push({ hunk: cur });
        prev = cur;
      }
      prevEnd = Math.max(prevEnd, h.n + newCount(h) - 1);
    });
    if (expandable) {
      const n = f.hunks.length;
      if (text == null) {
        parts.push({ gap: n, hidden: null, trailing: true });
      } else {
        const size = text.length - prevEnd;
        const top = Math.min((ex[n] || { top: 0 }).top, Math.max(0, size));
        for (let k = 0; k < top; k++) {
          prev.lines.push(" " + text[prevEnd + k]);
        }
        if (size - top > 0) {
          parts.push({ gap: n, hidden: size - top, trailing: true });
        }
      }
    }
    return parts;
  }

  // Index of the paired line for each removed / added line of a hunk (runs of − followed by runs of +).
  function partners(lines) {
    const map = new Map();
    let i = 0;
    while (i < lines.length) {
      if (lines[i].charAt(0) !== "-") {
        i++;
        continue;
      }
      const d = i;
      while (i < lines.length && lines[i].charAt(0) === "-") {
        i++;
      }
      const a = i;
      while (i < lines.length && lines[i].charAt(0) === "+") {
        i++;
      }
      for (let k = 0; k < Math.min(a - d, i - a); k++) {
        map.set(d + k, a + k);
        map.set(a + k, d + k);
      }
    }
    return map;
  }

  function quote(code) {
    const s = code.trim();
    if (s === "") {
      return "empty line";
    }
    const clipped = s.length > 120 ? s.slice(0, 120) + "…" : s;
    return clipped.indexOf("`") >= 0 ? "`` " + clipped + " ``" : "`" + clipped + "`";
  }

  function where(c) {
    return c.from != null && c.from.line !== c.line ? c.from.line + "-" + c.line : String(c.line);
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  // Del/add runs are paired line by line; context lines fill both sides.
  function splitRows(h) {
    const rows = [];
    let o = h.o;
    let n = h.n;
    let dels = [];
    let adds = [];
    const flush = function () {
      for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
        rows.push({ l: dels[i] || null, r: adds[i] || null });
      }
      dels = [];
      adds = [];
    };
    h.lines.forEach(function (line) {
      const sign = line.charAt(0);
      const code = line.slice(1);
      if (sign === "-") {
        dels.push({ sign: "-", line: o, code: code });
        o += 1;
      } else if (sign === "+") {
        adds.push({ sign: "+", line: n, code: code });
        n += 1;
      } else {
        flush();
        rows.push({ l: { sign: " ", line: o, code: code }, r: { sign: " ", line: n, code: code } });
        o += 1;
        n += 1;
      }
    });
    flush();
    return rows;
  }

  function relTo(root) {
    return function (path) {
      return root != null && path.indexOf(root + "/") === 0 ? path.slice(root.length + 1) : path;
    };
  }

  function turnSource(user, files) {
    return { id: "turn:" + user.id, label: "your edits in the turn \"" + util.firstLine(user.text, 80) + "\"", turn: user.id, ts: user.ts, text: user.text, files: files };
  }

  // "Claude's edits in a turn" from the store: every user prompt followed by Edit / Write results with a patch.
  function turnsFromStore(store, root) {
    const turns = [];
    let cur = null;
    (store != null ? store.items : []).forEach(function (it) {
      if (it.k === "user" && it.agent == null) {
        cur = it.command ? null : { uuid: it.id, ts: it.ts, text: it.text, tools: [] };
        if (cur != null) {
          turns.push(cur);
        }
      } else if (cur != null && it.k === "tool") {
        cur.tools.push(it);
      }
    });
    const rel = relTo(root);
    return turns.map(function (t) {
      return { uuid: t.uuid, ts: t.ts, text: t.text, files: store.editedFiles(t.tools, rel) };
    }).filter(function (t) {
      return t.files.length > 0;
    });
  }

  function Review(section, toggleBtn, deps) {
    this.section = section;
    this.toggleBtn = toggleBtn;
    this.deps = deps;
    this.key = "review:" + CC.host.viewId();
    this.files = [];
    this.root = null;
    this.comments = [];
    this.anchors = new Set();
    this.rows = new Map();
    this.threads = new Map();
    this.heads = new Map();
    this.boxes = new Map();
    this.items = new Map();
    this.collapsed = new Set();
    this.active = null;
    this.mode = "unified";
    this.loading = false;
    this.src = WORKTREE;
    this.expands = new Map();
    this.texts = new Map();
    this.order = new Map();
    this.pick = null;
    this.stuck = null;
    this.badge = el("span", "hdr-badge hidden");
    toggleBtn.appendChild(this.badge);

    const self = this;
    const bar = el("div", "rv-bar");
    this.sideBtn = el("button", "icon-btn");
    this.sideBtn.type = "button";
    this.sideBtn.title = "Changed files";
    this.sideBtn.appendChild(util.icon("sidebar"));
    this.sideBtn.addEventListener("click", function () {
      self.setSide(!self.sideOpen(), true);
    });
    this.sourceSel = el("select", "hdr-select rv-source");
    this.sourceSel.title = "What to review";
    this.sourceSel.addEventListener("change", function () {
      self.pickSource(self.sourceSel.value);
    });
    this.rangeInput = el("input", "rv-range hidden");
    this.rangeInput.type = "text";
    this.rangeInput.placeholder = "main..HEAD";
    this.rangeInput.spellcheck = false;
    this.rangeInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && self.rangeInput.value.trim() !== "") {
        const r = self.rangeInput.value.trim();
        self.setSource({ id: "range:" + r, label: "the commit range " + r, range: r });
      } else if (e.key === "Escape") {
        e.preventDefault();
        self.rangeInput.classList.add("hidden");
        self.sourceSel.value = self.src.id;
      }
    });
    bar.append(this.sideBtn, el("span", "rv-title", "Changes"), this.sourceSel, this.rangeInput);
    this.summary = el("span", "rv-summary");
    bar.appendChild(this.summary);
    const seg = el("div", "rv-seg");
    this.modeBtns = {};
    [["unified", "Unified", "One column, old and new lines interleaved"], ["split", "Side by side", "Old on the left, new on the right"]].forEach(function (m) {
      const b = el("button", null, m[1]);
      b.type = "button";
      b.title = m[2];
      b.addEventListener("click", function () {
        self.setMode(m[0], true);
      });
      self.modeBtns[m[0]] = b;
      seg.appendChild(b);
    });
    const refresh = el("button", "icon-btn");
    refresh.type = "button";
    refresh.title = "Reload the diff";
    refresh.appendChild(util.icon("refresh"));
    refresh.addEventListener("click", function () {
      self.load();
    });
    this.sendBtn = el("button", "chip-btn primary");
    this.sendBtn.type = "button";
    this.sendBtn.title = "Send all comments to Claude as one message";
    this.sendBtn.addEventListener("click", function () {
      self.send();
    });
    const close = el("button", "icon-btn");
    close.type = "button";
    close.title = "Back to the chat";
    close.appendChild(util.icon("x"));
    close.addEventListener("click", function () {
      self.setOpen(false);
    });
    const search = el("button", "icon-btn");
    search.type = "button";
    search.title = "Find in changes (Ctrl/Cmd+F)";
    search.appendChild(util.icon("search"));
    search.addEventListener("click", function () {
      self.find.open();
    });
    this.foldBtn = el("button", "icon-btn rv-fold");
    this.foldBtn.type = "button";
    this.foldBtn.addEventListener("click", function () {
      self.foldAll(!self.allFolded());
    });
    bar.append(seg, this.foldBtn, search, refresh, this.sendBtn, close);

    this.side = el("aside", "rv-side");
    this.sideHead = el("div", "rv-side-head");
    this.sideList = el("div", "rv-side-list");
    this.sideList.tabIndex = 0;
    this.sideList.addEventListener("keydown", function (e) {
      self.sideKey(e);
    });
    const grip = el("div", "rv-grip");
    grip.addEventListener("pointerdown", function (e) {
      self.resize(e, grip);
    });
    this.side.append(this.sideHead, this.sideList, grip);

    this.orphans = el("div", "rv-orphans hidden");
    this.list = el("div", "rv-files");
    this.scroll = el("div", "rv-scroll");
    this.scroll.append(this.orphans, this.list);
    let ticking = false;
    this.scroll.addEventListener("scroll", function () {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(function () {
          ticking = false;
          self.trackActive();
        });
      }
    });
    this.lazy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          self.lazy.unobserve(e.target);
          e.target.seen = true;
          e.target.paint();
        }
      });
    }, { root: this.scroll, rootMargin: "800px 0px" });
    const main = el("div", "rv-main");
    main.append(this.side, this.scroll);
    section.append(bar, main);
    this.findNeedle = "";
    this.find = new CC.Find({
      scroller: this.scroll,
      root: this.list,
      mount: main,
      roots: ".rv-code, .rv-path",
      placeholder: "Find in changes",
      highlight: "cc-rv-find",
      horizontal: true,
      active: function () {
        return !section.classList.contains("hidden");
      },
      prepare: function (needle) {
        self.unfoldMatches(needle);
      },
    });

    toggleBtn.addEventListener("click", function () {
      self.setOpen(section.classList.contains("hidden"));
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !e.defaultPrevented && !section.classList.contains("hidden") &&
        document.querySelector(".lightbox, .settings-overlay:not(.hidden)") == null) {
        e.preventDefault();
        self.setOpen(false);
      }
    });
    CC.host.storageGet(this.key).then(function (v) {
      self.comments = Array.isArray(v) ? v : [];
      self.updateCount();
      if (self.files.length > 0) {
        self.render();
      }
    });
    CC.host.storageGet("review:mode").then(function (v) {
      self.setMode(v === "split" ? "split" : "unified", false);
    });
    CC.host.storageGet("review:sideWidth").then(function (v) {
      if (typeof v === "number") {
        self.side.style.width = v + "px";
      }
    });
    CC.host.storageGet("review:side").then(function (v) {
      self.setSide(v !== false && !window.matchMedia(NARROW).matches, false);
    });
    this.setMode("unified", false);
    this.updateFold();
    this.updateCount();
  }

  Review.prototype.setOpen = function (open) {
    this.section.classList.toggle("hidden", !open);
    this.toggleBtn.classList.toggle("active", open);
    if (open) {
      this.load();
      this.loadSources();
    }
  };

  Review.prototype.loadSources = async function () {
    this.fillSources();
    try {
      const res = await CC.host.reader("reviewSources", { cwd: this.deps.cwd() || ".", file: this.deps.file() });
      this.sources = res;
      this.fillSources();
    } catch (e) {
      console.warn("review sources failed", e && e.message);
    }
  };

  // Store turns first (live, newest first); transcript turns only for what the store does not hold (older history).
  Review.prototype.turnSources = function () {
    const res = this.sources || { turns: [] };
    const live = turnsFromStore(this.deps.store, res.root || null).reverse();
    const out = live.map(function (t) {
      return turnSource({ id: t.uuid, ts: t.ts, text: t.text }, t.files);
    });
    (res.turns || []).forEach(function (t) {
      const dup = live.some(function (l) {
        return l.uuid === t.uuid || (l.text === t.text && Math.abs(Date.parse(l.ts) - Date.parse(t.ts)) < 5000);
      });
      if (!dup) {
        out.push({ id: "turn:" + t.uuid, label: "your edits in the turn \"" + util.firstLine(t.text, 80) + "\"", turn: t.uuid, ts: t.ts, text: t.text });
      }
    });
    return out;
  };

  // The diff chip under a turn in the transcript: that turn's edits.
  Review.prototype.openTurn = function (user, tools) {
    this.src = turnSource(user, this.deps.store.editedFiles(tools, relTo((this.sources || {}).root || this.deps.cwd() || null)));
    this.files = [];
    this.setOpen(true);
  };

  Review.prototype.fillSources = function () {
    const sel = this.sourceSel;
    const res = this.sources || { turns: [], commits: [] };
    const known = new Map();
    sel.textContent = "";
    const add = function (parent, src, text) {
      known.set(src.id, src);
      const o = new Option(text, src.id);
      o.title = text;
      parent.appendChild(o);
    };
    add(sel, WORKTREE, "Uncommitted changes");
    if (res.base != null) {
      add(sel, { id: "base:" + res.base, label: "this branch's changes against " + res.base, base: res.base }, "Branch vs " + res.base);
    }
    const turns = this.turnSources();
    if (turns.length > 0) {
      const g = el("optgroup");
      g.label = "Claude's edits in a turn";
      turns.forEach(function (t) {
        add(g, t, util.fmtTime(t.ts) + " · " + t.text);
      });
      sel.appendChild(g);
    }
    if (res.commits.length > 0) {
      const g = el("optgroup");
      g.label = "Commits";
      res.commits.forEach(function (c) {
        add(g, { id: "commit:" + c.sha, label: "commit " + c.short + " (" + c.subject + ")", commit: c.sha }, c.short + " " + c.subject);
      });
      sel.appendChild(g);
    }
    if (!known.has(this.src.id)) {
      add(sel, this.src, this.src.range != null ? this.src.range : this.src.base != null ? "Branch vs " + this.src.base : this.src.label);
    }
    sel.appendChild(new Option("Commit range…", "range"));
    sel.value = this.src.id;
    this.known = known;
  };

  Review.prototype.pickSource = function (id) {
    if (id === "range") {
      this.rangeInput.classList.remove("hidden");
      this.rangeInput.focus();
      this.rangeInput.select();
      return;
    }
    this.rangeInput.classList.add("hidden");
    const src = this.known.get(id);
    if (src != null) {
      this.setSource(src);
    }
  };

  Review.prototype.setSource = function (src) {
    this.src = src;
    this.rangeInput.classList.add("hidden");
    this.files = [];
    this.fillSources();
    this.load();
  };

  Review.prototype.sideOpen = function () {
    return !this.side.classList.contains("hidden");
  };

  Review.prototype.setSide = function (open, remember) {
    this.side.classList.toggle("hidden", !open);
    this.sideBtn.classList.toggle("active", open);
    if (remember) {
      CC.host.storageSet("review:side", open);
    }
  };

  Review.prototype.setMode = function (mode, remember) {
    const changed = mode !== this.mode;
    this.mode = mode;
    this.modeBtns.unified.classList.toggle("active", mode === "unified");
    this.modeBtns.split.classList.toggle("active", mode === "split");
    this.list.classList.toggle("rv-split", mode === "split");
    if (remember) {
      CC.host.storageSet("review:mode", mode);
    }
    if (changed && this.files.length > 0) {
      const keep = this.active;
      this.render();
      if (keep != null) {
        this.reveal(keep, false);
      }
    }
  };

  Review.prototype.resize = function (e, grip) {
    const self = this;
    const startX = e.clientX;
    const startW = this.side.offsetWidth;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add("rv-resizing");
    const move = function (ev) {
      self.side.style.width = Math.max(160, Math.min(560, startW + ev.clientX - startX)) + "px";
    };
    const up = function () {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      document.body.classList.remove("rv-resizing");
      CC.host.storageSet("review:sideWidth", self.side.offsetWidth);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    e.preventDefault();
  };

  Review.prototype.load = async function () {
    if (this.loading) {
      return;
    }
    this.loading = true;
    if (this.files.length === 0) {
      this.list.textContent = "";
      this.list.appendChild(el("div", "rv-empty", "Loading the diff…"));
    }
    try {
      const src = this.src;
      const res = src.files != null ? { root: (this.sources || {}).root || this.deps.cwd() || null, files: src.files }
        : await CC.host.reader("diff", { cwd: this.deps.cwd() || ".", turn: src.turn, file: src.turn != null ? this.deps.file() : null, commit: src.commit, range: src.range, base: src.base });
      if (src !== this.src) {
        return;
      }
      if (res.error) {
        this.files = [];
        this.showEmpty(res.error);
        return;
      }
      this.files = res.files || [];
      this.expands.clear();
      this.texts.clear();
      this.root = res.root;
      this.truncated = res.truncated === true;
      this.render();
    } catch (e) {
      util.toast("Diff failed: " + e.message, "error");
    } finally {
      this.loading = false;
    }
  };

  Review.prototype.showEmpty = function (text) {
    this.list.textContent = "";
    this.list.appendChild(el("div", "rv-empty", text));
    this.summary.textContent = "";
    this.sideHead.textContent = "";
    this.sideList.textContent = "";
    this.items.clear();
    this.renderOrphans();
  };

  Review.prototype.render = function () {
    const self = this;
    this.rows.clear();
    this.threads.clear();
    this.heads.clear();
    this.boxes.clear();
    this.anchors = new Set();
    this.order.clear();
    this.seq = 0;
    this.pick = null;
    let add = 0;
    let del = 0;
    this.files.forEach(function (f) {
      add += f.add;
      del += f.del;
      self.addAnchors(f);
    });
    if (this.files.length === 0) {
      this.showEmpty(this.src === WORKTREE ? "No changes against HEAD." : this.src.base != null ? "No changes against " + this.src.base + "." : "No changes.");
      return;
    }
    const totals = plural(this.files.length, "file") + " · +" + add + " −" + del + (this.truncated ? " · truncated" : "");
    this.summary.textContent = totals;
    this.summary.title = this.root || "";
    this.renderSide(add, del);
    this.list.textContent = "";
    this.lazy.disconnect();
    this.files.forEach(function (f) {
      const box = self.fileNode(f);
      self.list.appendChild(box);
      self.lazy.observe(box);
    });
    this.renderOrphans();
    this.trackActive();
    this.find.refresh();
  };

  // A new query unfolds collapsed files that contain it; files collapsed while searching stay collapsed.
  Review.prototype.unfoldMatches = function (needle) {
    const self = this;
    if (needle === this.findNeedle) {
      return;
    }
    this.findNeedle = needle;
    this.files.forEach(function (f) {
      if (!self.collapsed.has(f.path)) {
        return;
      }
      const hit = f.path.toLowerCase().indexOf(needle) >= 0 || f.hunks.some(function (h) {
        return h.lines.some(function (l) {
          return l.toLowerCase().indexOf(needle, 1) >= 0;
        });
      });
      if (hit) {
        self.collapsed.delete(f.path);
        self.boxes.get(f.path).fill();
      }
    });
  };

  Review.prototype.expandKey = function (f) {
    return this.src.id + "\n" + f.path;
  };

  Review.prototype.parts = function (f) {
    const key = this.expandKey(f);
    return viewParts(f, this.expands.get(key) || {}, this.texts.has(key) ? this.texts.get(key).lines || null : null);
  };

  Review.prototype.addAnchors = function (f) {
    const self = this;
    const src = this.src.id;
    this.parts(f).forEach(function (p) {
      if (p.hunk == null) {
        return;
      }
      splitRows(p.hunk).forEach(function (r) {
        if (r.l != null) {
          self.anchors.add(anchorKey(src, f.path, r.l.sign, r.l.sign === " " ? r.r.line : r.l.line));
        }
        if (r.r != null) {
          self.anchors.add(anchorKey(src, f.path, r.r.sign, r.r.line));
        }
      });
    });
  };

  // File text of the diff's new side (working tree, or the commit / range end), fetched once per file.
  Review.prototype.fileText = async function (f) {
    const key = this.expandKey(f);
    let entry = this.texts.get(key);
    if (entry == null) {
      const src = this.src;
      const rev = src.commit || (src.range != null ? rangeHead(src.range) : null);
      entry = { lines: null, job: CC.host.reader("fileText", { cwd: this.deps.cwd() || ".", path: f.path, rev: rev }) };
      this.texts.set(key, entry);
    }
    try {
      const res = await entry.job;
      entry.lines = res.lines || [];
      return entry.lines;
    } catch (e) {
      this.texts.delete(key);
      util.toast("Cannot load " + f.path + ": " + e.message, "error");
      return null;
    }
  };

  Review.prototype.expand = async function (f, gap, side) {
    const src = this.src;
    if (await this.fileText(f) == null || src !== this.src) {
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
    this.addAnchors(f);
    const box = this.boxes.get(f.path);
    if (box != null) {
      const top = this.scroll.scrollTop;
      box.fill();
      this.scroll.scrollTop = top;
    }
    this.renderOrphans();
  };

  Review.prototype.gapRow = function (f, p) {
    const self = this;
    const row = el("div", "rv-hunk" + (p.hidden !== 0 ? " has-exp" : ""));
    if (p.hidden !== 0) {
      const btns = el("span", "rv-exp-btns");
      const btn = function (name, title, side) {
        const b = el("button", "rv-exp");
        b.type = "button";
        b.title = title;
        b.appendChild(util.icon(name));
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          self.expand(f, p.gap, side);
        });
        btns.appendChild(b);
      };
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
        btn("unfold", p.hidden == null ? "Show the rest of the file" : "Show all " + p.hidden + " hidden lines", "all");
      }
      row.appendChild(btns);
    }
    const h = p.head;
    row.appendChild(el("span", "rv-hunk-label", h != null ? "@@ −" + h.o + " +" + h.n + " @@" + (h.head ? " " + h.head : "") : ""));
    if (p.hidden !== 0) {
      row.appendChild(el("span", "rv-hidden", p.hidden == null ? "more lines below" : p.hidden + (p.hidden === 1 ? " hidden line" : " hidden lines")));
    }
    return row;
  };

  Review.prototype.renderSide = function (add, del) {
    const self = this;
    this.sideHead.textContent = "";
    this.sideHead.append(el("span", "rv-side-title", plural(this.files.length, "file")), el("span", "rv-stat add", "+" + add), el("span", "rv-stat del", "−" + del));
    this.sideHead.title = this.root || "";
    this.sideList.textContent = "";
    this.items.clear();
    this.files.forEach(function (f) {
      const slash = f.path.lastIndexOf("/");
      const item = el("div", "rv-item st-" + f.status);
      item.title = (f.status === "renamed" && f.old ? f.old + " → " : "") + f.path;
      const name = el("div", "rv-item-name");
      name.append(el("span", "rv-letter", STATUS[f.status] || "M"), el("span", "rv-fname", f.path.slice(slash + 1)));
      const badge = el("span", "rv-cbadge hidden");
      name.appendChild(badge);
      const meta = el("div", "rv-item-meta");
      meta.appendChild(el("span", "rv-dir", slash > 0 ? f.path.slice(0, slash) : ""));
      meta.append(el("span", "rv-stat add", "+" + f.add), el("span", "rv-stat del", "−" + f.del));
      item.append(name, meta);
      item.addEventListener("click", function () {
        self.reveal(f.path, true);
      });
      self.items.set(f.path, { root: item, badge: badge });
      self.sideList.appendChild(item);
      self.updateHeadCount(f.path);
    });
  };

  Review.prototype.sideKey = function (e) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") {
      return;
    }
    e.preventDefault();
    const paths = this.files.map(function (f) {
      return f.path;
    });
    const i = paths.indexOf(this.active);
    const next = paths[Math.max(0, Math.min(paths.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next != null) {
      this.reveal(next, false);
    }
  };

  Review.prototype.reveal = function (path, fromClick) {
    const box = this.boxes.get(path);
    if (box == null) {
      return;
    }
    if (this.collapsed.has(path)) {
      this.collapsed.delete(path);
      box.fill();
    }
    this.scroll.scrollTop = box.offsetTop - 12;
    this.setActive(path);
    if (fromClick && window.matchMedia(NARROW).matches) {
      this.setSide(false, false);
    }
  };

  Review.prototype.trackActive = function () {
    const self = this;
    let current = null;
    const top = this.scroll.scrollTop + 24;
    this.boxes.forEach(function (box, path) {
      if (current == null || box.offsetTop <= top) {
        current = path;
      }
    });
    if (current != null && current !== this.active) {
      self.setActive(current);
    }
    const box = this.boxes.get(current);
    const stuck = box != null && !this.collapsed.has(current) && this.scroll.scrollTop > box.offsetTop ? box : null;
    if (stuck !== this.stuck) {
      if (this.stuck != null) {
        this.stuck.classList.remove("stuck");
      }
      if (stuck != null) {
        stuck.classList.add("stuck");
      }
      this.stuck = stuck;
    }
  };

  Review.prototype.setActive = function (path) {
    const prev = this.items.get(this.active);
    if (prev != null) {
      prev.root.classList.remove("active");
    }
    this.active = path;
    const item = this.items.get(path);
    if (item != null) {
      item.root.classList.add("active");
      item.root.scrollIntoView({ block: "nearest" });
    }
  };

  Review.prototype.fileNode = function (f) {
    const self = this;
    const box = el("div", "rv-file");
    const head = el("div", "rv-file-head");
    head.title = "Collapse or expand (Alt+click: all files)";
    head.appendChild(util.icon("chevron"));
    const name = el("span", "rv-path st-" + f.status, f.status === "renamed" && f.old ? f.old + " → " + f.path : f.path);
    name.title = f.path;
    head.appendChild(name);
    const count = el("span", "rv-ccount");
    head.appendChild(count);
    head.appendChild(el("span", "rv-stat add", "+" + f.add));
    head.appendChild(el("span", "rv-stat del", "−" + f.del));
    this.heads.set(f.path, count);
    this.updateHeadCount(f.path);
    const body = el("div", "rv-file-body");
    box.append(head, body);
    box.fill = function () {
      self.rows.forEach(function (v, k) {
        if (pathOfKey(k) === f.path) {
          self.rows.delete(k);
          self.threads.delete(k);
          self.order.delete(k);
        }
      });
      const open = !self.collapsed.has(f.path);
      box.classList.toggle("collapsed", !open);
      body.textContent = "";
      if (open) {
        self.fillBody(f, body);
        if (box.seen) {
          self.paint(f, box);
        }
      }
      self.updateFold();
      self.find.refresh();
    };
    box.paint = function () {
      self.paint(f, box);
    };
    head.addEventListener("click", function (e) {
      if (e.altKey) {
        self.foldAll(!self.collapsed.has(f.path));
        return;
      }
      const stuck = self.scroll.scrollTop > box.offsetTop;
      if (self.collapsed.has(f.path)) {
        self.collapsed.delete(f.path);
      } else {
        self.collapsed.add(f.path);
      }
      box.fill();
      if (stuck) {
        self.scroll.scrollTop = box.offsetTop - 12;
      }
      self.trackActive();
    });
    this.boxes.set(f.path, box);
    box.fill();
    return box;
  };

  Review.prototype.paint = function (f, box) {
    const lang = CC.markdown.langFromPath(f.path);
    if (lang === "" || this.collapsed.has(f.path)) {
      return;
    }
    const tok = { old: new Map(), new: new Map() };
    this.parts(f).forEach(function (p) {
      if (p.hunk != null) {
        hunkTokens(p.hunk, lang, tok);
      }
    });
    box.querySelectorAll(".rv-code").forEach(function (node) {
      const runs = tok[node.hl.side].get(node.hl.line);
      if (runs != null && runs.map(function (r) {
        return r[0];
      }).join("") === node.hl.text) {
        paintCode(node, runs, node.hl.segs);
      }
    });
    this.find.refresh();
  };

  Review.prototype.allFolded = function () {
    const self = this;
    return this.files.length > 0 && this.files.every(function (f) {
      return self.collapsed.has(f.path);
    });
  };

  Review.prototype.updateFold = function () {
    const all = this.allFolded();
    this.foldBtn.title = all ? "Expand all files" : "Collapse all files";
    this.foldBtn.textContent = "";
    this.foldBtn.appendChild(util.icon(all ? "unfold" : "fold"));
  };

  // The current file's header stays at the top.
  Review.prototype.foldAll = function (fold) {
    const self = this;
    const keep = this.active;
    this.files.forEach(function (f) {
      if (self.collapsed.has(f.path) !== fold) {
        if (fold) {
          self.collapsed.add(f.path);
        } else {
          self.collapsed.delete(f.path);
        }
        self.boxes.get(f.path).fill();
      }
    });
    const box = this.boxes.get(keep);
    if (box != null) {
      this.scroll.scrollTop = box.offsetTop - 12;
    }
    this.trackActive();
  };

  Review.prototype.fillBody = function (f, body) {
    const self = this;
    if (f.binary) {
      body.appendChild(el("div", "rv-note", "Binary file"));
      return;
    }
    if (f.hunks.length === 0) {
      body.appendChild(el("div", "rv-note", f.truncated ? "Too large to show" : "No content changes"));
      return;
    }
    const keys = [];
    this.parts(f).forEach(function (part) {
      if (part.hunk == null) {
        body.appendChild(self.gapRow(f, part));
        return;
      }
      const h = part.hunk;
      if (self.mode === "split") {
        splitRows(h).forEach(function (r) {
          const row = el("div", "rv-srow");
          const w = r.l != null && r.r != null && r.l.sign === "-" ? wordDiff(r.l.code, r.r.code) : null;
          row.append(self.half(f, r.l, r.r, row, "l", keys, w != null ? w[0] : null), self.half(f, r.r, r.r, row, "r", keys, w != null ? w[1] : null));
          body.appendChild(row);
        });
        return;
      }
      let o = h.o;
      let n = h.n;
      const pairs = partners(h.lines);
      const words = new Map();
      h.lines.forEach(function (line, idx) {
        const sign = line.charAt(0);
        const row = el("div", "rv-line" + (sign === "+" ? " add" : sign === "-" ? " del" : ""));
        if (sign === "-" && pairs.has(idx)) {
          const w = wordDiff(line.slice(1), h.lines[pairs.get(idx)].slice(1));
          if (w != null) {
            words.set(idx, w[0]);
            words.set(pairs.get(idx), w[1]);
          }
        }
        row.append(el("span", "rv-ln", sign === "+" ? "" : String(o)), el("span", "rv-ln", sign === "-" ? "" : String(n)));
        row.append(el("span", "rv-sign", sign === " " ? "" : sign), codeNode(line.slice(1), words.get(idx) || null, sign === "-" ? "old" : "new", sign === "-" ? o : n));
        self.bindLine(f, row, { sign: sign, line: sign === "-" ? o : n, code: line.slice(1) }, row, null, keys);
        body.appendChild(row);
        if (sign !== "+") {
          o += 1;
        }
        if (sign !== "-") {
          n += 1;
        }
      });
    });
    if (f.truncated) {
      body.appendChild(el("div", "rv-note", "Diff truncated"));
    }
    keys.forEach(function (key) {
      if (self.comments.some(function (c) {
        return keyOf(c) === key;
      })) {
        self.renderThread(key);
      }
    });
    this.markRanges();
  };

  Review.prototype.rangeKeys = function (fromKey, toKey) {
    const a = this.order.get(fromKey);
    const b = this.order.get(toKey);
    const out = [];
    if (a == null || b == null) {
      return out;
    }
    this.order.forEach(function (i, key) {
      if (i >= Math.min(a, b) && i <= Math.max(a, b)) {
        out.push(key);
      }
    });
    return out;
  };

  // Rows covered by a range comment (or by the range being picked) get a bar on the left.
  Review.prototype.markRanges = function () {
    const self = this;
    this.section.querySelectorAll(".rv-ranged").forEach(function (n) {
      n.classList.remove("rv-ranged");
    });
    const mark = function (from, to) {
      self.rangeKeys(from, to).forEach(function (key) {
        const at = self.rows.get(key);
        if (at != null) {
          at.cell.classList.add("rv-ranged");
        }
      });
    };
    this.comments.forEach(function (c) {
      if (c.from != null) {
        mark(anchorKey(c.src || WORKTREE.id, c.path, c.from.sign, c.from.line), keyOf(c));
      }
    });
    if (this.picking != null) {
      mark(this.picking[0], this.picking[1]);
    }
  };

  // A context line anchors to its new line number on both sides, like in the unified view.
  Review.prototype.half = function (f, cell, right, row, side, keys, segs) {
    if (cell == null) {
      return el("div", "rv-half empty");
    }
    const node = el("div", "rv-half" + (cell.sign === "+" ? " add" : cell.sign === "-" ? " del" : ""));
    node.append(el("span", "rv-ln", String(cell.line)), el("span", "rv-sign", cell.sign === " " ? "" : cell.sign), codeNode(cell.code, segs, side === "l" ? "old" : "new", cell.line));
    const anchor = cell.sign === " " ? right : cell;
    this.bindLine(f, node, anchor, row, cell.sign === " " ? "r" : side, keys);
    return node;
  };

  // Click comments a line; Shift+click comments the range from the last clicked line of the same file.
  Review.prototype.bindLine = function (f, node, cell, row, side, keys) {
    const self = this;
    const key = anchorKey(this.src.id, f.path, cell.sign, cell.line);
    const anchor = { path: f.path, sign: cell.sign, line: cell.line, code: cell.code };
    node.addEventListener("mousedown", function (e) {
      if (e.shiftKey) {
        e.preventDefault();
      }
    });
    node.addEventListener("click", function (e) {
      if (window.getSelection().toString() !== "") {
        return;
      }
      const pick = self.pick;
      if (e.shiftKey && pick != null && pick.anchor.path === f.path && pick.key !== key) {
        const first = self.order.get(pick.key) < self.order.get(key);
        const from = first ? pick : { key: key, anchor: anchor };
        const to = first ? { key: key, anchor: anchor } : pick;
        const prev = self.threads.get(pick.key);
        if (prev != null && prev.editor != null && prev.editor.querySelector("textarea").value.trim() === "") {
          prev.editor.remove();
          prev.editor = null;
        }
        self.openEditor(to.key, Object.assign({}, to.anchor, { from: { sign: from.anchor.sign, line: from.anchor.line, code: from.anchor.code } }), from.key);
        return;
      }
      self.pick = { key: key, anchor: anchor };
      self.openEditor(key, anchor, null);
    });
    if (!this.rows.has(key)) {
      this.rows.set(key, { row: row, side: side, cell: node });
      this.order.set(key, this.seq++);
      keys.push(key);
    }
  };

  Review.prototype.thread = function (key) {
    let t = this.threads.get(key);
    if (t == null) {
      const at = this.rows.get(key);
      t = { node: el("div", "rv-thread" + (at.side != null ? " side-" + at.side : "")), list: el("div", "rv-thread-list"), editor: null };
      t.node.appendChild(t.list);
      at.row.after(t.node);
      this.threads.set(key, t);
    }
    return t;
  };

  Review.prototype.renderThread = function (key) {
    const self = this;
    if (!this.rows.has(key)) {
      return;
    }
    const t = this.thread(key);
    t.list.textContent = "";
    this.comments.filter(function (c) {
      return keyOf(c) === key;
    }).forEach(function (c) {
      t.list.appendChild(self.commentBox(c));
    });
  };

  Review.prototype.renderOrphans = function () {
    const self = this;
    const lost = this.comments.filter(function (c) {
      return !self.anchors.has(keyOf(c));
    });
    this.orphans.textContent = "";
    this.orphans.classList.toggle("hidden", lost.length === 0);
    if (lost.length === 0) {
      return;
    }
    this.orphans.appendChild(el("div", "rv-orphans-head", "Comments on lines no longer in the diff (still sent)"));
    lost.forEach(function (c) {
      self.orphans.appendChild(self.commentBox(c, true));
    });
  };

  Review.prototype.openEditor = function (key, anchor, fromKey) {
    const self = this;
    const t = this.thread(key);
    if (t.editor != null) {
      t.editor.remove();
      t.editor = null;
    }
    this.picking = fromKey != null ? [fromKey, key] : null;
    this.markRanges();
    t.editor = this.editor(null, anchor, function () {
      t.editor.remove();
      t.editor = null;
      self.picking = null;
      self.markRanges();
    });
    t.node.appendChild(t.editor);
    t.editor.querySelector("textarea").focus();
  };

  Review.prototype.editor = function (c, anchor, done) {
    const self = this;
    const box = el("div", "rv-editor");
    const from = c != null ? c.from : anchor.from;
    if (from != null) {
      box.appendChild(el("div", "rv-range-label", "Lines " + from.line + "–" + (c != null ? c.line : anchor.line)));
    }
    const ta = el("textarea", "rv-input");
    ta.rows = 3;
    ta.placeholder = "Comment for Claude…";
    ta.value = c != null ? c.text : "";
    const actions = el("div", "rv-editor-actions");
    actions.appendChild(el("span", "rv-hint", "⌘↵ save · Esc cancel"));
    const cancel = el("button", "chip-btn", "Cancel");
    cancel.type = "button";
    const save = el("button", "chip-btn primary", c != null ? "Save" : "Add comment");
    save.type = "button";
    actions.append(cancel, save);
    box.append(ta, actions);
    const finish = done;
    const commit = function () {
      const text = ta.value.trim();
      if (text === "" && c == null) {
        finish();
        return;
      }
      if (text === "") {
        self.remove(c);
      } else if (c != null) {
        c.text = text;
      } else {
        self.comments.push({
          id: util.uid(), src: self.src.id, srcLabel: self.src.label, path: anchor.path, sign: anchor.sign, line: anchor.line, code: anchor.code,
          from: anchor.from || null, text: text,
        });
      }
      finish();
      self.changed(c != null ? keyOf(c) : anchorKey(self.src.id, anchor.path, anchor.sign, anchor.line));
    };
    cancel.addEventListener("click", finish);
    save.addEventListener("click", commit);
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish();
      }
    });
    return box;
  };

  Review.prototype.commentBox = function (c, withAnchor) {
    const self = this;
    const box = el("div", "rv-comment");
    const top = el("div", withAnchor ? "rv-comment-top" : "rv-comment-top floating");
    if (withAnchor) {
      const other = (c.src || WORKTREE.id) !== this.src.id ? (c.srcLabel || "another diff") + " · " : "";
      top.appendChild(el("span", "rv-anchor", other + c.path + ":" + where(c) + " " + quote(c.code)));
      top.appendChild(el("span", "rv-spacer"));
    } else if (c.from != null) {
      top.appendChild(el("span", "rv-range-label", "Lines " + c.from.line + "–" + c.line));
      top.appendChild(el("span", "rv-spacer"));
    }
    const edit = el("button", "icon-btn");
    edit.type = "button";
    edit.title = "Edit";
    edit.appendChild(util.icon("edit"));
    edit.addEventListener("click", function () {
      const ed = self.editor(c, null, function () {
        ed.replaceWith(box);
      });
      box.replaceWith(ed);
      ed.querySelector("textarea").focus();
    });
    const del = el("button", "icon-btn");
    del.type = "button";
    del.title = "Delete";
    del.appendChild(util.icon("trash"));
    del.addEventListener("click", function () {
      self.remove(c);
      self.changed(keyOf(c));
    });
    top.append(edit, del);
    box.append(top, el("div", "rv-comment-text", c.text));
    return box;
  };

  Review.prototype.remove = function (c) {
    this.comments = this.comments.filter(function (x) {
      return x.id !== c.id;
    });
  };

  Review.prototype.changed = function (key) {
    CC.host.storageSet(this.key, this.comments.length > 0 ? this.comments : null);
    this.updateCount();
    this.updateHeadCount(pathOfKey(key));
    this.markRanges();
    if (this.anchors.has(key)) {
      this.renderThread(key);
    } else {
      this.renderOrphans();
    }
  };

  Review.prototype.updateHeadCount = function (path) {
    const src = this.src.id;
    const n = this.comments.filter(function (c) {
      return c.path === path && (c.src || WORKTREE.id) === src;
    }).length;
    const node = this.heads.get(path);
    if (node != null) {
      node.textContent = n > 0 ? plural(n, "comment") : "";
    }
    const item = this.items.get(path);
    if (item != null) {
      item.badge.textContent = String(n);
      item.badge.title = plural(n, "draft comment");
      item.badge.classList.toggle("hidden", n === 0);
    }
  };

  Review.prototype.updateCount = function () {
    const n = this.comments.length;
    this.badge.textContent = String(n);
    this.badge.classList.toggle("hidden", n === 0);
    this.toggleBtn.title = n > 0 ? "Review changes · " + n + " pending comment" + (n === 1 ? "" : "s") : "Review changes";
    this.sendBtn.textContent = n > 0 ? "Send " + n + (n === 1 ? " comment" : " comments") : "Send comments";
    this.sendBtn.disabled = n === 0;
  };

  Review.prototype.send = function () {
    if (this.comments.length === 0) {
      return;
    }
    const order = new Map();
    this.files.forEach(function (f, i) {
      order.set(f.path, i);
    });
    const sorted = this.comments.slice().sort(function (a, b) {
      const fa = order.has(a.path) ? order.get(a.path) : order.size;
      const fb = order.has(b.path) ? order.get(b.path) : order.size;
      return fa - fb || a.path.localeCompare(b.path) || a.line - b.line;
    });
    const groups = new Map();
    sorted.forEach(function (c) {
      const src = c.src || WORKTREE.id;
      if (!groups.has(src)) {
        groups.set(src, { label: c.srcLabel || WORKTREE.label, lines: [] });
      }
      const code = c.from != null ? quote(c.from.code) + " … " + quote(c.code) : quote(c.code);
      const what = c.sign === " " || c.from != null ? code : c.sign + " " + code;
      groups.get(src).lines.push("- " + c.path + ":" + where(c) + " (" + what + "): " + c.text.replace(/\n/g, "\n  "));
    });
    const parts = [];
    groups.forEach(function (g, src) {
      const head = groups.size === 1 && src === WORKTREE.id ? "Review comments on the current diff:" : "Review comments on " + g.label + ":";
      parts.push(head + "\n" + g.lines.join("\n"));
    });
    this.deps.send(parts.join("\n\n"));
    this.comments = [];
    CC.host.storageSet(this.key, null);
    this.updateCount();
    this.render();
    this.setOpen(false);
  };

  Review.turnsFromStore = turnsFromStore;
  return Review;
})();
