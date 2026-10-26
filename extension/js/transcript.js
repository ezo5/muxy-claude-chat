window.CC = window.CC || {};

// Renders the conversation from a CC.Store: items arrive through the store's events, counts and labels come from
// the model.
CC.Transcript = (function () {
  const util = CC.util;
  const el = util.el;

  function Builder(view, target) {
    this.view = view;
    this.target = target;
    this.turn = null;
    this.steps = null;
    this.cmd = null;
    this.user = null;
  }

  Builder.prototype.ensureTurn = function (item) {
    if (this.turn == null) {
      this.turn = el("div", "turn assistant");
      this.turn.appendChild(el("div", "turn-body"));
      this.turn._items = [];
      this.turn._user = this.user;
      this.target.appendChild(this.turn);
      this.steps = null;
    }
    this.turn._items.push(item);
    return this.turn.firstChild;
  };

  Builder.prototype.closeTurn = function () {
    this.turn = null;
    this.steps = null;
  };

  Builder.prototype.add = function (item) {
    const v = this.view;
    if (item.k === "result") {
      v.applyResult(item.tid, item);
      return;
    }
    if (item.agent != null) {
      return;
    }
    const cmd = this.cmd;
    this.cmd = null;
    if (item.k === "user") {
      if (this.turn != null) {
        v.foldSteps(this.turn);
        v.turnFoot(this.turn, null);
      }
      this.closeTurn();
      this.user = item;
      if (item.command) {
        this.cmd = v.commandRow(item);
        this.target.appendChild(this.cmd);
      } else {
        this.target.appendChild(v.userBubble(item));
      }
      v.onUserItem(item);
      return;
    }
    if (item.k === "notice" && item.level === "command" && cmd != null && this.target.lastChild === cmd) {
      v.commandOutput(cmd, item.text);
      return;
    }
    if (item.k === "notice") {
      if (item.level === "task" || item.level === "handback" || item.level === "interrupt") {
        const body = this.ensureTurn(item);
        body.appendChild(v.notice(item));
        this.steps = null;
      } else {
        this.closeTurn();
        this.target.appendChild(v.notice(item));
      }
      return;
    }
    if (item.k === "turn") {
      if (this.turn != null) {
        v.foldSteps(this.turn);
        v.turnFoot(this.turn, item);
      }
      this.closeTurn();
      return;
    }
    const body = this.ensureTurn(item);
    if (item.k === "text") {
      this.steps = null;
      body.appendChild(v.assistantText(item));
    } else if (item.k === "thinking") {
      if (CC.Store.isStep(item) || item.partial === true) {
        this.step(body, item, v.thinking(item));
      }
    } else if (item.k === "tool") {
      const tv = CC.tools.render(item, { cwd: v.cwd });
      v.toolViews.set(item.id, tv);
      tv.root.classList.toggle("partial", item.partial === true);
      const run = this.openRun(body, item);
      if (CC.Store.STANDALONE_TOOLS[item.name] === true) {
        this.steps = null;
        body.appendChild(tv.root);
      } else if (run != null) {
        this.steps._items.push(item);
        run.add(tv, item);
        v.runs.set(item.id, run);
      } else {
        this.step(body, item, tv.root);
        v.startRun(tv, item);
      }
      const r = v.store.resultOf(item.id);
      if (r != null && item.partial !== true) {
        v.applyResult(item.id, r);
      }
    }
  };

  // The run a tool joins: same run kind as the card or group right before it in the current steps.
  Builder.prototype.openRun = function (body, item) {
    const kind = CC.Store.runKind(item);
    const steps = this.steps;
    if (kind == null || steps == null || steps.parentNode !== body || body.lastChild !== steps) {
      return null;
    }
    const run = this.view.runAt(steps.lastChild);
    return run != null && run.kind === kind ? run : null;
  };

  Builder.prototype.step = function (body, item, node) {
    if (this.steps == null || this.steps.parentNode !== body || body.lastChild !== this.steps) {
      this.steps = el("div", "steps");
      this.steps._items = [];
      body.appendChild(this.steps);
    }
    this.steps._items.push(item);
    this.steps.appendChild(node);
  };

  function Transcript(scroller, opts) {
    this.scroller = scroller;
    this.opts = opts || {};
    this.store = this.opts.store || new CC.Store();
    this.log = el("div", "log");
    this.olderBar = el("div", "older-bar");
    this.pendingBox = el("div", "pending-box");
    this.working = el("div", "working hidden");
    this.working.appendChild(el("span", "spark"));
    this.workingLabel = el("span", "working-label", "Working…");
    this.working.appendChild(this.workingLabel);
    this.empty = el("div", "empty-state hidden");
    const inner = el("div", "log-inner");
    inner.append(this.olderBar, this.empty, this.log, this.pendingBox, this.working);
    scroller.appendChild(inner);
    this.cwd = "";
    this.clear();
    this.subscribe();
    this.find = new CC.Find({
      scroller: scroller,
      root: this.log,
      mount: scroller.parentNode,
      roots: ".bubble-text, .assistant-text > .md, .tool-title",
      placeholder: "Find in conversation",
      highlight: "cc-find",
      active: function () {
        return document.querySelector(".review.hidden") != null;
      },
      bottom: function () {
        return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--footer-h")) || 0;
      },
    });
    this.following = false;
    this.unseen = 0;
    this.fresh = false;
    const self = this;
    scroller.addEventListener("scroll", function () {
      self.onScroll();
    });
    scroller.addEventListener("wheel", function (e) {
      if (e.deltaY < 0) {
        self.following = false;
        self.pinned = false;
      }
    }, { passive: true });
    // Tabs restored in the background lay out at zero size; a pinned view stays at the latest when the viewport grows.
    this.pinned = true;
    new ResizeObserver(function () {
      requestAnimationFrame(function () {
        if (self.pinned) {
          self.scrollToBottom(false);
        }
      });
    }).observe(scroller);
    this.jump = this.opts.jump || null;
    if (this.jump != null) {
      this.jumpBadge = el("span", "jump-badge");
      this.jump.appendChild(this.jumpBadge);
      this.jump.addEventListener("click", function () {
        self.following = true;
        self.scrollToBottom(true);
      });
    }
  }

  Transcript.prototype.subscribe = function () {
    const self = this;
    const store = this.store;
    store.on("reset", function () {
      self.clear();
      self.pendingBox.textContent = "";
      self.updateOlderBar();
      self.find.refresh();
    });
    store.on("items:add", function (items) {
      self.render(items);
      self.find.refresh();
    });
    store.on("items:prepend", function (items) {
      self.renderOlder(items);
      self.find.refresh();
    });
    store.on("items:update", function (e) {
      self.updateItem(e.item);
      self.find.refresh();
    });
    store.on("state", function () {
      if (store.hasOlder !== self.hasOlder) {
        self.setHasOlder(store.hasOlder);
      }
    });
  };

  Transcript.prototype.clear = function () {
    this.log.textContent = "";
    this.log.classList.remove("show-cut");
    this.toolViews = new Map();
    this.runs = new Map();
    this.textViews = new Map();
    this.thinkingViews = new Map();
    this.builder = new Builder(this, this.log);
    this.hasOlder = false;
    this.loadingOlder = false;
  };

  Transcript.prototype.startRun = function (tv, item) {
    const kind = CC.Store.runKind(item);
    if (kind != null) {
      const store = this.store;
      this.runs.set(item.id, new CC.tools.Group(kind, tv, item, function (items) {
        return store.stepsLabel(items);
      }));
    }
  };

  Transcript.prototype.runAt = function (node) {
    if (node == null || node.nodeType !== 1) {
      return null;
    }
    return node._group || this.runs.get(node.dataset.tid) || null;
  };

  Transcript.prototype.refreshRun = function (tid) {
    const run = this.runs.get(tid);
    if (run != null) {
      run.refresh();
    }
  };

  // A dropped thinking row can leave two runs of one kind next to each other; they merge as a reload would show them.
  Transcript.prototype.mergeRuns = function (prev, next) {
    const a = this.runAt(prev);
    const b = this.runAt(next);
    if (a == null || b == null || a === b || a.kind !== b.kind) {
      return;
    }
    const self = this;
    b.views.forEach(function (tv, i) {
      a.add(tv, b.items[i]);
      self.runs.set(b.items[i].id, a);
    });
    if (b.c != null) {
      b.c.root.remove();
    }
  };

  Transcript.prototype.applyResult = function (tid, result) {
    const tool = this.toolViews.get(tid);
    if (tool == null) {
      return;
    }
    tool.result(result);
    this.toolViews.delete(tid);
    this.refreshRun(tid);
  };

  Transcript.prototype.updateItem = function (item) {
    if (item.k === "text") {
      const tv = this.textViews.get(item.id);
      if (tv != null) {
        tv.update(item);
      }
    } else if (item.k === "tool") {
      const tool = this.toolViews.get(item.id);
      if (tool != null) {
        tool.update(item.input || {}, item);
        tool.root.classList.toggle("partial", item.partial === true);
        this.refreshRun(item.id);
        const r = item.partial !== true ? this.store.resultOf(item.id) : null;
        if (r != null) {
          this.applyResult(item.id, r);
        }
      }
    } else if (item.k === "thinking") {
      const view = this.thinkingViews.get(item.id);
      if (view == null) {
        return;
      }
      if (item.partial !== true && !CC.Store.isStep(item)) {
        const steps = view.root.parentNode;
        const prev = view.root.previousSibling;
        const next = view.root.nextSibling;
        view.root.remove();
        this.mergeRuns(prev, next);
        if (steps != null && steps._items != null) {
          steps._items.splice(steps._items.indexOf(item), 1);
          if (steps._items.length === 0) {
            steps.remove();
            if (this.builder.steps === steps) {
              this.builder.steps = null;
            }
          }
        }
        this.thinkingViews.delete(item.id);
      } else {
        view.update();
      }
    }
  };

  Transcript.prototype.atBottom = function () {
    const s = this.scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 60;
  };

  // At the bottom, or on the way there after the jump button: new content keeps the view pinned.
  Transcript.prototype.sticky = function () {
    return this.following || this.atBottom();
  };

  Transcript.prototype.scrollToBottom = function (smooth) {
    this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  Transcript.prototype.render = function (items) {
    if (items.length === 0) {
      return;
    }
    const stick = this.sticky();
    for (const item of items) {
      try {
        this.builder.add(item);
      } catch (e) {
        console.error("render failed", item.k, e && e.message);
      }
    }
    this.updateEmpty();
    if (stick || this.pinned) {
      this.scrollToBottom(false);
    } else {
      this.fresh = true;
      this.unseen += items.filter(function (it) {
        return (it.k === "text" || (it.k === "user" && !it.command)) && it.agent == null;
      }).length;
    }
    this.onScroll();
  };

  // Older items go in front; every turn in the chunk has ended, so all of them fold.
  Transcript.prototype.renderOlder = function (items) {
    const frag = document.createDocumentFragment();
    const b = new Builder(this, frag);
    for (const item of items) {
      try {
        b.add(item);
      } catch (e) {
        console.error("render failed", item.k, e && e.message);
      }
    }
    const self = this;
    Array.prototype.forEach.call(frag.querySelectorAll(".turn"), function (turn) {
      self.foldSteps(turn);
    });
    const before = this.scroller.scrollHeight;
    const top = this.scroller.scrollTop;
    this.log.insertBefore(frag, this.log.firstChild);
    this.scroller.scrollTop = top + (this.scroller.scrollHeight - before);
    this.updateEmpty();
  };

  Transcript.prototype.foldSteps = function (turn) {
    const self = this;
    turn.querySelectorAll(".steps").forEach(function (steps) {
      const items = steps._items || [];
      const n = items.length;
      if (n === 0 || steps.querySelector(".steps-toggle") != null) {
        return;
      }
      const failed = self.store.failedCount(items);
      const toggle = el("button", "steps-toggle");
      toggle.type = "button";
      toggle.title = n + (n === 1 ? " step" : " steps");
      toggle.appendChild(util.icon("chevron"));
      const label = self.store.stepsLabel(items);
      toggle.appendChild(el("span", "steps-label", label));
      if (failed > 0) {
        toggle.appendChild(el("span", "failed-count", failed + " failed"));
      }
      toggle.addEventListener("click", function () {
        steps.classList.toggle("folded");
      });
      steps.querySelectorAll(":scope > .tool-group").forEach(function (g) {
        g.classList.toggle("tg-same", g._group.label(g._group.items) === label);
      });
      steps.insertBefore(toggle, steps.firstChild);
      steps.classList.add("foldable", "folded");
    });
  };

  // Without a `turn` item (transcripts of -p sessions, interrupted TUI turns) the next prompt closes the turn and
  // the footer comes from timestamps.
  Transcript.prototype.turnFoot = function (turn, item) {
    const user = turn._user;
    if (turn._foot != null || (item == null && (user == null || user.command))) {
      return;
    }
    const stats = this.store.turnStats(turn._items, user != null ? user.ts : null, item);
    const label = this.store.turnLabel(stats);
    const chip = user != null && this.opts.openTurn != null ? this.diffChip(user, turn._items) : null;
    if (label === "" && chip == null) {
      return;
    }
    turn._foot = el("div", "turn-foot");
    if (chip != null) {
      turn._foot.appendChild(chip);
    }
    const st = el("span", "turn-stats", label);
    if (stats.end != null) {
      st.title = "Finished " + util.fmtTime(stats.end);
    }
    turn._foot.appendChild(st);
    turn.appendChild(turn._foot);
  };

  Transcript.prototype.diffChip = function (user, items) {
    const files = this.store.editedFiles(items);
    if (files.length === 0) {
      return null;
    }
    const opts = this.opts;
    const chip = el("button", "diff-chip");
    chip.type = "button";
    chip.title = "Review the changes of this turn";
    chip.appendChild(util.icon("diff"));
    chip.appendChild(el("span", null, files.length + (files.length === 1 ? " file" : " files")));
    chip.appendChild(el("span", "plus", "+" + files.reduce(function (a, f) {
      return a + f.add;
    }, 0)));
    chip.appendChild(el("span", "minus", "−" + files.reduce(function (a, f) {
      return a + f.del;
    }, 0)));
    chip.addEventListener("click", function () {
      opts.openTurn(user, items);
    });
    return chip;
  };

  Transcript.prototype.setHasOlder = function (has) {
    this.hasOlder = has;
    this.store.setHasOlder(has);
    this.updateOlderBar();
  };

  Transcript.prototype.updateOlderBar = function () {
    const self = this;
    this.olderBar.textContent = "";
    if (this.hasOlder) {
      const btn = el("button", "ghost-btn", this.loadingOlder ? "Loading…" : "Load earlier messages");
      btn.addEventListener("click", function () {
        self.requestOlder();
      });
      this.olderBar.appendChild(btn);
    }
  };

  Transcript.prototype.requestOlder = async function () {
    if (!this.hasOlder || this.loadingOlder || this.opts.loadOlder == null) {
      return;
    }
    this.loadingOlder = true;
    this.updateOlderBar();
    try {
      await this.opts.loadOlder();
    } finally {
      this.loadingOlder = false;
      this.updateOlderBar();
    }
  };

  Transcript.prototype.onScroll = function () {
    if (this.scroller.scrollTop < 150 && this.hasOlder && this.log.childNodes.length > 0 && !this.cutHidden()) {
      this.requestOlder();
    }
    const bottom = this.atBottom();
    if (bottom) {
      this.pinned = true;
    } else if (this.scroller.clientHeight > 0) {
      this.pinned = false;
    }
    if (bottom) {
      this.following = false;
      this.fresh = false;
      this.unseen = 0;
    }
    if (this.jump != null) {
      this.jump.classList.toggle("hidden", bottom);
      this.jump.classList.toggle("fresh", this.fresh);
      this.jumpBadge.textContent = this.unseen > 9 ? "9+" : this.unseen > 0 ? String(this.unseen) : "";
      this.jump.title = this.unseen > 0 ? this.unseen + (this.unseen === 1 ? " new message" : " new messages") : "Jump to latest";
    }
  };

  Transcript.prototype.refreshPins = function () {
    const pins = this.opts.pins;
    this.log.querySelectorAll("[data-mid]").forEach(function (row) {
      row.classList.toggle("pinned", pins.has(row.dataset.pin));
    });
  };

  // The store says whether the item is loaded; older chunks are pulled until it is (or nothing older is left).
  Transcript.prototype.jumpTo = async function (id) {
    const self = this;
    const find = function () {
      return Array.prototype.find.call(self.log.querySelectorAll("[data-mid]"), function (r) {
        return r.dataset.pin === id || r.dataset.mid === id;
      });
    };
    const loaded = function () {
      return self.store.items.some(function (it) {
        return it.id === id || CC.Pins.key(it) === id;
      });
    };
    for (let i = 0; !loaded() && this.hasOlder && i < 50; i++) {
      await this.requestOlder();
    }
    const row = find();
    if (row == null) {
      util.toast("Message is no longer in this conversation", "error");
      return;
    }
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.remove("flash");
    void row.offsetWidth;
    row.classList.add("flash");
  };

  Transcript.prototype.updateEmpty = function () {
    this.empty.classList.toggle("hidden", this.log.childNodes.length > 0 || this.pendingBox.childNodes.length > 0);
  };

  Transcript.prototype.setEmptyText = function (title, sub, keys) {
    this.empty.textContent = "";
    if (title) {
      this.empty.appendChild(el("div", "empty-title", title));
    }
    if (sub) {
      this.empty.appendChild(el("div", "empty-sub", sub));
    }
    if (keys != null) {
      const list = el("dl", "empty-keys");
      keys.forEach(function (k) {
        const dt = el("dt");
        k[0].split(" ").forEach(function (key, i) {
          if (i > 0) {
            dt.appendChild(el("span", "key-plus", "+"));
          }
          dt.appendChild(el("kbd", null, key));
        });
        list.append(dt, el("dd", null, k[1]));
      });
      this.empty.appendChild(list);
    }
    this.updateEmpty();
  };

  Transcript.prototype.setWorking = function (on, label) {
    const stick = this.sticky();
    this.working.classList.toggle("hidden", !on);
    if (label != null) {
      this.workingLabel.textContent = label;
    }
    if (stick && on) {
      this.scrollToBottom(false);
    }
  };

  Transcript.prototype.meta = function (row, ts, getText, item, who) {
    const bar = el("div", "msg-actions");
    if (getText != null) {
      bar.appendChild(util.copyButton(getText));
    }
    if (item != null && item.id != null && this.opts.pins != null) {
      const pins = this.opts.pins;
      pins.rekey(item);
      row.dataset.mid = item.id;
      row.dataset.pin = CC.Pins.key(item);
      row.classList.toggle("pinned", pins.has(row.dataset.pin));
      const pin = el("button", "copy-btn pin-btn");
      pin.type = "button";
      pin.title = "Pin message";
      pin.appendChild(util.icon("pin"));
      pin.addEventListener("click", function (e) {
        e.stopPropagation();
        row.classList.toggle("pinned", pins.toggle(item, who));
      });
      bar.appendChild(pin);
    }
    if (who === "claude" && getText != null && this.opts.followUp != null) {
      const opts = this.opts;
      const reply = el("button", "copy-btn");
      reply.type = "button";
      reply.title = "Ask a follow-up";
      reply.appendChild(util.icon("reply"));
      reply.addEventListener("click", function (e) {
        e.stopPropagation();
        opts.followUp(getText());
      });
      bar.appendChild(reply);
    }
    if (ts) {
      const t = el("span", "msg-time", util.fmtTime(ts));
      t.title = new Date(ts).toLocaleString();
      bar.appendChild(t);
    }
    row.appendChild(bar);
  };

  Transcript.prototype.userBubble = function (item) {
    const row = el("div", "row user-row");
    const bubble = el("div", "bubble");
    const shown = item.images > 0 ? item.text.replace(/\[Image #\d+\]\s?/g, "").trim() : item.text;
    const local = item.images > 0 && this.opts.previewsFor != null ? this.opts.previewsFor(item) : null;
    if (local != null) {
      bubble.appendChild(CC.images.local(local, item.images, "bubble-thumbs"));
    } else if (item.images > 0) {
      bubble.appendChild(CC.images.strip(this.file, item.id, item.images));
    }
    const review = item.images > 0 ? null : CC.reviewNote.parse(shown);
    if (review != null) {
      bubble.classList.add("bubble-review");
      bubble.appendChild(CC.reviewNote.render(review));
    } else if (shown !== "" || !(item.images > 0)) {
      const text = el("div", "bubble-text", shown);
      bubble.appendChild(text);
      if (item.text.length > 1200 || item.text.split("\n").length > 18) {
        bubble.classList.add("clamped");
        const more = el("button", "more-btn", "Show more");
        more.addEventListener("click", function () {
          const c = bubble.classList.toggle("clamped");
          more.textContent = c ? "Show more" : "Show less";
        });
        bubble.appendChild(more);
      }
    }
    if (item.queued) {
      bubble.appendChild(el("div", "bubble-note", "sent while Claude was working"));
    }
    row.appendChild(bubble);
    this.meta(row, item.ts, function () {
      return item.text;
    }, item, "user");
    this.rewindButtons(row.lastChild, item);
    return row;
  };

  Transcript.prototype.rewindButtons = function (bar, item) {
    const rewind = this.opts.rewind;
    if (rewind == null || rewind.target(item) == null) {
      return;
    }
    [["edit", "Edit and resend", function () {
      rewind.edit(item);
    }], ["rewind", "Rewind to here", function (btn) {
      rewind.open(item, btn);
    }]].forEach(function (a) {
      const btn = el("button", "copy-btn rewind-act");
      btn.type = "button";
      btn.title = a[1];
      btn.appendChild(util.icon(a[0]));
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        a[2](btn);
      });
      bar.insertBefore(btn, bar.querySelector(".msg-time"));
    });
  };

  const CLEAR = /^\/(clear|reset|new)(\s|$)/;

  // Slash commands: a divider for /clear, otherwise one card with the command and its output.
  Transcript.prototype.commandRow = function (item) {
    if (CLEAR.test(item.text)) {
      const d = this.cutMark("New conversation");
      d.classList.add("cmd-clear");
      d.firstChild.title = item.text + (item.ts ? " · " + util.fmtTime(item.ts) : "");
      return d;
    }
    const row = el("div", "row cmd-row");
    const card = el("div", "cmd-card");
    const head = el("div", "cmd-head");
    head.appendChild(util.icon("terminal"));
    head.appendChild(el("code", "cmd", item.text));
    card.appendChild(head);
    row.appendChild(card);
    this.meta(row, item.ts, function () {
      return item.text;
    }, null, "user");
    return row;
  };

  // Everything before the last cut mark (/clear divider or "Chat cleared") stays collapsed until the mark is clicked.
  Transcript.prototype.cutMark = function (text) {
    const log = this.log;
    const scroller = this.scroller;
    const d = el("div", "notice divider cut-mark");
    const span = el("span");
    const label = el("b", "cut-label");
    label.append(util.icon("chevron"), el("span", null, text));
    span.appendChild(label);
    span.addEventListener("click", function () {
      if (d.previousElementSibling == null) {
        return;
      }
      const top = d.getBoundingClientRect().top;
      log.classList.toggle("show-cut");
      scroller.scrollTop += d.getBoundingClientRect().top - top;
    });
    d.appendChild(span);
    return d;
  };

  Transcript.prototype.cutHidden = function () {
    return !this.log.classList.contains("show-cut") && this.log.querySelector(":scope > .cut-mark") != null;
  };

  Transcript.prototype.wipe = function () {
    this.builder.closeTurn();
    this.builder.cmd = null;
    this.log.classList.remove("show-cut");
    this.log.appendChild(this.cutMark("Chat cleared"));
    this.scrollToBottom(false);
    this.onScroll();
  };

  Transcript.prototype.commandOutput = function (row, text) {
    const card = row.querySelector(".cmd-card");
    if (card == null) {
      return;
    }
    const short = text.split("\n").length <= 2 && text.length < 400;
    const out = short ? CC.markdown.render(text, { cwd: this.cwd }) : el("pre", null, text);
    out.classList.add("cmd-out");
    card.appendChild(out);
  };

  // Streaming text re-renders its markdown at most once per animation frame.
  Transcript.prototype.assistantText = function (item) {
    const self = this;
    const row = el("div", "assistant-text" + (item.err ? " api-error" : ""));
    if (item.err) {
      row.appendChild(util.icon("alert"));
    }
    let content = CC.markdown.render(item.text, { cwd: this.cwd });
    row.appendChild(content);
    row.classList.toggle("partial", item.partial === true);
    this.meta(row, item.ts, function () {
      return item.text;
    }, item, "claude");
    let frame = 0;
    let rendered = item.text;
    function paint() {
      frame = 0;
      row.classList.toggle("partial", item.partial === true);
      if (item.text === rendered) {
        return;
      }
      rendered = item.text;
      const stick = self.sticky();
      const fresh = CC.markdown.render(item.text, { cwd: self.cwd });
      content.replaceWith(fresh);
      content = fresh;
      if (stick) {
        self.scrollToBottom(false);
      }
    }
    this.textViews.set(item.id, {
      root: row,
      update: function () {
        if (frame === 0) {
          frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(paint) : setTimeout(paint, 16);
        }
      },
    });
    return row;
  };

  // Collapsed to a label and the latest line; streaming repaints in place once per frame, so an opened row stays open.
  Transcript.prototype.thinking = function (item) {
    const row = el("details", "thinking-row");
    const sum = el("summary");
    const label = el("span", "thinking-label");
    const spin = el("span", "thinking-spin");
    const preview = el("span", "thinking-preview");
    const text = el("div", "thinking-text");
    sum.append(util.icon("brain"), label, spin, preview);
    row.append(sum, text);
    let frame = 0;
    function paint() {
      frame = 0;
      const lines = item.text.split("\n").map(function (l) {
        return l.replace(/[*_`#>]+/g, "").trim();
      }).filter(Boolean);
      label.textContent = item.partial === true ? "Thinking" : CC.Store.thinkingLabel(item);
      preview.textContent = lines.length > 0 ? lines[lines.length - 1] : "";
      text.textContent = item.text;
      row.classList.toggle("partial", item.partial === true);
      row.classList.toggle("empty", !item.text);
    }
    paint();
    this.thinkingViews.set(item.id, {
      root: row,
      update: function () {
        if (frame === 0) {
          frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(paint) : setTimeout(paint, 16);
        }
      },
    });
    return row;
  };

  Transcript.prototype.notice = function (item) {
    if (item.level === "command") {
      const box = el("div", "notice command-out");
      box.appendChild(el("pre", null, item.text));
      return box;
    }
    if (item.level === "compact") {
      const det = el(item.detail ? "details" : "div", "notice divider");
      const label = el(item.detail ? "summary" : "span", null, item.text);
      det.appendChild(label);
      if (item.detail) {
        const d = el("div", "compact-summary");
        d.appendChild(CC.markdown.render(item.detail));
        det.appendChild(d);
      }
      return det;
    }
    if (item.level === "handback") {
      return this.handback(item);
    }
    const n = el("div", "notice level-" + item.level + (item.status === "failed" ? " failed" : ""));
    if (item.level === "task") {
      n.appendChild(util.icon(item.status === "failed" ? "alert" : "bot"));
    } else if (item.level === "warning" || item.level === "error") {
      n.appendChild(util.icon("alert"));
    }
    n.appendChild(el("span", null, item.text));
    if (item.ts) {
      n.title = util.fmtTime(item.ts);
    }
    return n;
  };

  // A subagent's SubagentHandback report: a collapsed card like the Agent tool's.
  Transcript.prototype.handback = function (item) {
    const root = el("div", "tool tool-agent expandable");
    const head = el("div", "tool-head");
    const title = el("div", "tool-title");
    title.append(el("span", "tool-verb", "Agent report"), el("span", "tool-target", item.text || this.agentTitle(item.agentId) || "Subagent"));
    const chev = util.icon("chevron");
    chev.classList.add("chev");
    head.append(util.icon("bot"), title, chev);
    if (item.ts) {
      head.title = util.fmtTime(item.ts);
    }
    const body = el("div", "tool-body");
    const report = el("div", "agent-result");
    report.appendChild(CC.markdown.render(item.detail || ""));
    body.appendChild(report);
    root.append(head, body);
    head.addEventListener("click", function () {
      root.classList.toggle("open");
    });
    return root;
  };

  // Description of the Agent call whose result names this agent id (history items may lack it).
  Transcript.prototype.agentTitle = function (agentId) {
    for (const r of this.store.results.values()) {
      if (r.extra != null && r.extra.agentId === agentId) {
        const tool = this.store.tool(r.tid);
        return tool != null && tool.input != null ? tool.input.description || null : null;
      }
    }
    return null;
  };

  Transcript.prototype.addPending = function (entry) {
    const row = el("div", "row user-row pending");
    const bubble = el("div", "bubble");
    if (entry.images > 0) {
      bubble.appendChild(CC.images.local(entry.previews, entry.images, "bubble-thumbs"));
    }
    if (entry.text || !(entry.images > 0)) {
      bubble.appendChild(el("div", "bubble-text", entry.text || ""));
    }
    const spinner = el("span", "send-spinner");
    spinner.title = "Sending";
    const note = el("div", "bubble-note hidden");
    bubble.append(spinner, note);
    row.appendChild(bubble);
    row._entry = entry;
    row._note = note;
    row._spinner = spinner;
    entry.row = row;
    this.pendingBox.appendChild(row);
    this.updateEmpty();
    this.scrollToBottom(true);
    return row;
  };

  Transcript.prototype.setPendingNote = function (entry, text, failed) {
    if (entry.row == null) {
      return;
    }
    entry.row._spinner.remove();
    entry.row._note.classList.remove("hidden");
    entry.row._note.textContent = text;
    entry.row.classList.toggle("failed", failed === true);
  };

  Transcript.prototype.removePending = function (entry) {
    if (entry.row != null) {
      entry.row.remove();
      entry.row = null;
    }
    this.updateEmpty();
  };

  Transcript.prototype.onUserItem = function (item) {
    const n = util.screenNorm(item.text).slice(0, 60);
    const rows = Array.prototype.slice.call(this.pendingBox.childNodes);
    for (const row of rows) {
      const e = row._entry;
      const pn = util.screenNorm(e.text).slice(0, 60);
      if (pn === n || (pn.length > 0 && n.indexOf(pn.slice(0, 30)) >= 0) || (pn.length === 0 && item.images > 0)) {
        row.remove();
        e.row = null;
        if (this.opts.onConfirmed != null) {
          this.opts.onConfirmed(e);
        }
        break;
      }
    }
  };

  return Transcript;
})();
