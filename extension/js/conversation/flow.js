// The conversation of one store in one element. Items arrive through the store's events; everything is on the instance, so two panes,
// also of one chat, never meet. env: {store, runtime?, chatId, cwd, readOnly, scroller, shell, quote(text), file()}.
CC.Flow = (function () {
  const util = CC.util;
  const el = util.el;
  const conv = CC.conv;
  const LOADER_AFTER_MS = 150;
  const HOLD_SILENCE_MS = 8000;
  const PAINT_MS = 70;
  const AT_END_PX = 2;
  const PLACE_DEPTH = 8;
  const PLACE_LEAF = /^(P|PRE|TABLE|H[1-6]|BUTTON|IMG|BLOCKQUOTE|HR)$/;
  const CLEAR = /^\/(clear|reset|new)(\s|$)/;
  const INLINE_NOTICE = { task: true, handback: true, interrupt: true };
  // Hidden in the flow: the running turn's task card shows the list.
  const QUIET_TOOLS = { TodoWrite: true };
  // A long chat builds only its end, and more as the reader gets near the top. All it costs is the store's items, which are there anyway.
  const WINDOW_TURNS = 50;
  const CHUNK_TURNS = 25;
  // Where a parked flow's scroller points: nothing laid out, nothing to move.
  const NO_SCROLLER = document.createElement("div");

  // Flows that wait for the page to show again. The event bubbles to the window, the one place outside CC.Keys it can be heard from.
  const waiting = new Set();
  window.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      Array.from(waiting).forEach(function (flow) {
        waiting.delete(flow);
        flow.paintHidden();
      });
    }
  });

  // Where the last `turns` turns of these items start. A chunk starts at a prompt, so it builds the same as in one go, also the turn's foot.
  function turnsStart(items, turns) {
    let seen = 0;
    for (let i = items.length - 1; i > 0; i--) {
      if (items[i].k === "user" && items[i].agent == null) {
        seen += 1;
        if (seen === turns) {
          return i;
        }
      }
    }
    return 0;
  }

  function Builder(view, target) {
    this.view = view;
    this.target = target;
    this.turn = null;
    this.work = null;
    this.cmd = null;
    this.user = null;
  }

  Builder.prototype.ensureTurn = function (item) {
    if (this.turn == null) {
      this.turn = el("div", "cv-turn");
      this.turn.appendChild(el("div", "cv-turn-body"));
      this.turn._items = [];
      this.turn._user = this.user;
      this.target.appendChild(this.turn);
      this.work = null;
    }
    this.turn._items.push(item);
    return this.turn.firstChild;
  };

  Builder.prototype.closeTurn = function () {
    this.turn = null;
    this.work = null;
  };

  Builder.prototype.workIn = function (body) {
    if (this.work == null || body.lastChild !== this.work.root) {
      this.work = new CC.Work(this.view);
      body.appendChild(this.work.root);
    }
    return this.work;
  };

  Builder.prototype.add = function (item) {
    const v = this.view;
    if (item.k === "result") {
      v.onResult(item);
      return;
    }
    if (item.agent != null) {
      v.agentStep(item);
      return;
    }
    const cmd = this.cmd;
    this.cmd = null;
    if (item.k === "user") {
      if (this.turn != null) {
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
      return;
    }
    if (item.k === "notice" && item.level === "command" && cmd != null && this.target.lastChild === cmd) {
      v.commandOutput(cmd, item.text);
      return;
    }
    if (item.k === "notice") {
      if (INLINE_NOTICE[item.level] === true) {
        const body = this.ensureTurn(item);
        body.appendChild(v.noticeEl(item));
        this.work = null;
      } else {
        this.closeTurn();
        this.target.appendChild(v.noticeEl(item));
      }
      return;
    }
    if (item.k === "turn") {
      if (this.turn != null) {
        v.turnFoot(this.turn, item);
      }
      this.closeTurn();
      return;
    }
    const body = this.ensureTurn(item);
    if (item.k === "text") {
      this.work = null;
      body.appendChild(v.answer(item));
    } else if (item.k === "thinking") {
      if (CC.Store.isStep(item) || item.partial === true) {
        const work = this.workIn(body);
        v.rows.set(item.id, { row: work.addThinking(item), work: work });
      }
    } else if (item.k === "tool") {
      if (QUIET_TOOLS[item.name] === true) {
        return;
      }
      if (CC.Store.STANDALONE_TOOLS[item.name] === true) {
        this.work = null;
        body.appendChild(v.standalone(item));
      } else {
        const work = this.workIn(body);
        v.rows.set(item.id, { row: work.addTool(item), work: work });
      }
    }
  };

  function Flow(el_, env) {
    this.barOf = new WeakMap();
    this.host = el_;
    this.env = env;
    this.store = env.store;
    this.scroller = env.scroller;
    this.mode = CC.Flow.viewMode();
    this.root = el("div", "cv-flow");
    this.root.dataset.mode = this.mode;
    this.older = el("div", "cv-older");
    this.empty = el("div", "cv-empty");
    this.empty.hidden = true;
    this.log = el("div", "cv-log");
    this.sendsBox = el("div", "cv-sends");
    this.root.append(this.older, this.empty, this.log, this.sendsBox);
    el_.appendChild(this.root);
    this.hiddenViews = new Set();
    this.touched = new Set();
    this.following = false;
    this.pinned = true;
    this.unseen = 0;
    this.fresh = false;
    this.onChange = null;   // jump button and find, set by the overlay
    this.offs = [];
    this.timers = new Set();
    this.domOffs = [];
    this.parked = false;
    this.clear();
    this.subscribe();
    this.bindDom();
    this.holdUntilLoaded();
    this.drawSends();
  }

  Flow.viewMode = function () {
    const v = CC.settings != null ? CC.settings.get("viewMode") : null;
    return v === "thinking" || v === "verbose" ? v : "normal";
  };

  Flow.prototype.server = function () {
    return CC.Servers.of(this.env.runtime);
  };

  Flow.prototype.cwd = function () {
    const m = this.store.meta || {};
    return m.cwd || this.env.cwd || "";
  };

  Flow.prototype.toolCtx = function () {
    const self = this;
    return {
      cwd: this.cwd(),
      resultOf: function (id) {
        return self.store.resultOf(id);
      },
      agentSteps: function (id) {
        return self.agentSteps.get(id) || [];
      },
    };
  };

  Flow.prototype.subscribe = function () {
    const self = this;
    const store = this.store;
    const on = function (name, fn) {
      self.offs.push(store.on(name, fn));
    };
    on("reset", function () {
      // Nothing of it stays valid, and a new view is as cheap as this one would be.
      if (self.parked) {
        self.unmount();
        return;
      }
      self.clear();
      self.updateOlder();
      self.changed();
      self.holdUntilLoaded();
    });
    // Its DOM goes with the chat, whatever else still holds the runtime.
    on("dispose", function () {
      if (self.parked) {
        self.unmount();
        self.clear();
      }
    });
    on("items:add", function (items) {
      if (self.parked) {
        self.missed.push({ add: items });
        return;
      }
      self.render(items);
      self.changed();
    });
    on("items:prepend", function (items) {
      if (self.parked) {
        self.missed.push({ prepend: items });
        return;
      }
      self.renderOlder(items);
      self.changed();
    });
    on("items:update", function (e) {
      if (self.parked) {
        self.missedUpdates.add(e.item);
        return;
      }
      self.updateItem(e.item);
      self.flush();
      self.changed();
    });
    on("state", function () {
      if (!self.parked) {
        self.stateChanged();
      }
    });
    on("sends", function () {
      if (!self.parked) {
        self.drawSends();
      }
    });
    on("mode", function () {
      if (!self.parked) {
        self.updateEmpty();
      }
    });
  };

  Flow.prototype.stateChanged = function () {
    this.syncOlder();
    if (this.store.status !== this.shownStatus) {
      this.shownStatus = this.store.status;
      this.refreshPromptActions();
    }
  };

  Flow.prototype.bindDom = function () {
    const self = this;
    const s = this.scroller;
    const onScroll = function () {
      self.onScroll();
    };
    // Ahead of the scroll event, so a repaint in between can't pull the view back down.
    const onWheel = function (e) {
      if (e.deltaY < 0 && s.scrollTop > 0) {
        self.release();
      } else if (e.deltaY > 0 && self.atBottom()) {
        self.pinned = true;
      }
    };
    s.addEventListener("scroll", onScroll, { passive: true });
    s.addEventListener("wheel", onWheel, { passive: true });
    this.domOffs.push(function () {
      s.removeEventListener("scroll", onScroll);
      s.removeEventListener("wheel", onWheel);
    });
    // Every size change comes through here before it is painted: following stays at the end, otherwise what the user reads stays put. A view
    // restored in the background lays out at zero size. The column also holds what flowEnd adds: the live line and the cards.
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(function () {
        if (!self.root.isConnected) {
          return;
        }
        if (self.restoring) {
          if (s.clientHeight > 0) {
            self.restore();
          }
          return;
        }
        if (self.sticky()) {
          self.scrollToBottom(false);
        } else {
          self.holdPlace();
        }
      });
      ro.observe(s);
      ro.observe(this.root);
      if (s.firstElementChild != null) {
        ro.observe(s.firstElementChild);
      }
      this.domOffs.push(function () {
        ro.disconnect();
      });
    }
    this.domOffs.push(CC.links.bind(this.root, function () {
      return { cwd: self.cwd(), chatId: self.env.chatId, file: self.env.file, server: self.server() };
    }));
    this.domOffs.push(CC.links.bindInlineCopy(s, this.root));
    if (this.env.readOnly !== true) {
      this.bindQuote();
    }
  };

  Flow.prototype.builtItems = function () {
    return this.store.items.length - this.unbuilt.length;
  };

  Flow.prototype.unbindDom = function () {
    this.domOffs.forEach(function (off) {
      off();
    });
    this.domOffs = [];
  };

  Flow.prototype.unmount = function () {
    this.hold = null;
    this.parked = false;
    this.unbindDom();
    this.offs.forEach(function (off) {
      off();
    });
    this.offs = [];
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    waiting.delete(this);
    if (this.host != null) {
      this.host.replaceChildren();
    }
  };

  // Off screen with its whole DOM, for when its chat is opened again. The store's events wait as a list, so a chat streaming meanwhile renders and lays out nothing;
  // its timers stay, as a paint they run into waits too. Called while the pane is still laid out.
  Flow.prototype.park = function () {
    const s = this.scroller;
    if (s.clientHeight > 0) {
      this.parkedTop = s.scrollTop;
      if (!this.sticky()) {
        this.notePlace();
      }
    }
    this.parked = true;
    this.missed = [];
    this.missedUpdates = new Set();
    this.unbindDom();
    this.root.remove();
    this.host = null;
    this.scroller = NO_SCROLLER;
    this.onChange = null;
  };

  // Back on screen, in a new pane. env has its scroller and pane. The pane may not be laid out yet, so the position comes back in restore().
  Flow.prototype.attach = function (host, env) {
    const self = this;
    Object.assign(this.env, env);
    this.host = host;
    this.scroller = env.scroller;
    host.appendChild(this.root);
    this.parked = false;
    this.restoring = true;
    this.bindDom();
    const mode = CC.Flow.viewMode();
    if (mode !== this.mode) {
      this.setMode(mode);
    }
    if (this.hold == null) {
      this.showHeld();
    }
    this.missed.forEach(function (m) {
      if (m.add != null) {
        self.render(m.add);
      } else {
        self.renderOlder(m.prepend);
      }
    });
    this.missedUpdates.forEach(function (item) {
      self.updateItem(item);
    });
    this.missed = [];
    this.missedUpdates = new Set();
    this.flush();
    this.stateChanged();
    this.drawSends();
    this.refreshPins();
    this.paintHidden();
    if (typeof ResizeObserver !== "function" || this.scroller.clientHeight > 0) {
      this.restore();
    }
  };

  // What followed the end is at the end again, with what came meanwhile; otherwise the place, also if the pane's width changed the heights above it.
  Flow.prototype.restore = function () {
    const s = this.scroller;
    this.restoring = false;
    if (this.following || this.pinned || this.parkedTop == null) {
      this.scrollToBottom(false);
    } else {
      s.scrollTop = this.parkedTop;
      this.holdPlace();
    }
    this.lastTop = s.scrollTop;
    this.lastHeight = s.clientHeight;
    this.lastContent = s.scrollHeight;
    this.onScroll();
  };

  Flow.prototype.later = function (fn, ms) {
    const self = this;
    const t = setTimeout(function () {
      self.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  };

  Flow.prototype.changed = function () {
    if (this.onChange != null) {
      this.onChange();
    }
  };

  // A chat arrives in batches, then its history. Until then the flow stays hidden, so it doesn't build up and scroll in front of the reader, and shows whole, at the end. Only a
  // wait long enough to notice gets the loader, and a server that doesn't answer can't hold it for long.
  Flow.prototype.holdUntilLoaded = function () {
    const self = this;
    const runtime = this.env.runtime;
    if (runtime == null || runtime.loaded == null) {
      return;
    }
    const hold = {};
    this.hold = hold;
    this.root.classList.add("is-holding");
    const showLoader = setTimeout(function () {
      if (self.hold === hold && self.loader == null) {
        self.loader = el("div", "cv-loader");
        self.loader.appendChild(CC.ui.spinner());
        self.loader.appendChild(el("span", null, "Loading…"));
        self.root.appendChild(self.loader);
      }
    }, LOADER_AFTER_MS);
    // Gives up on silence, not on length: a long chat keeps arriving well past this, and shown early it would build up in front of the reader.
    const giveUp = new Promise(function (resolve) {
      let items = -1;
      const check = setInterval(function () {
        if (self.hold !== hold || self.store.items.length === items) {
          clearInterval(check);
          resolve();
        }
        items = self.store.items.length;
      }, HOLD_SILENCE_MS);
    });
    this.holdDone = Promise.race([runtime.loaded(), giveUp]).catch(function () {}).then(function () {
      clearTimeout(showLoader);
      if (self.hold !== hold) {
        return;
      }
      self.hold = null;
      self.root.classList.remove("is-holding");
      if (self.loader != null) {
        self.loader.remove();
        self.loader = null;
      }
      if (self.parked) {
        return;
      }
      self.showHeld();
      if (self.sticky()) {
        self.scrollToBottom(false);
      }
      self.onScroll();
    });
  };

  // All that arrived behind the hold is here: only its end gets built.
  Flow.prototype.showHeld = function () {
    if (this.log.childNodes.length === 0 && this.unbuilt.length > 0) {
      const items = this.unbuilt;
      this.unbuilt = [];
      this.render(items);
    }
  };

  Flow.prototype.clear = function () {
    this.log.textContent = "";
    this.log.classList.remove("show-cut");
    this.rows = new Map();
    this.cards = new Map();
    this.notices = new Map();
    this.textViews = new Map();
    this.agentSteps = new Map();
    this.builder = new Builder(this, this.log);
    this.unbuilt = [];
    this.loadingOlder = false;
    this.hasOlder = this.store.hasOlder === true;
    this.touched.clear();
    this.updateEmpty();
  };

  // Summary lines are recomputed once per batch.
  Flow.prototype.touch = function (work) {
    this.touched.add(work);
  };

  Flow.prototype.flush = function () {
    this.touched.forEach(function (work) {
      if (work.isEmpty()) {
        work.root.remove();
      } else {
        work.refresh();
      }
    });
    this.touched.clear();
  };

  Flow.prototype.onResult = function (result) {
    const entry = this.rows.get(result.tid);
    if (entry != null) {
      entry.row.changed();
      this.touch(entry.work);
    }
    const card = this.cards.get(result.tid);
    if (card != null) {
      card.refresh();
    }
  };

  Flow.prototype.agentStep = function (item) {
    const parent = item.agent;
    let steps = this.agentSteps.get(parent);
    if (steps == null) {
      steps = [];
      this.agentSteps.set(parent, steps);
    }
    if ((item.k === "tool" || (item.k === "text" && item.text.trim() !== "")) && steps.indexOf(item) < 0) {
      steps.push(item);
    }
    const entry = this.rows.get(parent);
    if (entry != null) {
      entry.row.changed();
    }
  };

  Flow.prototype.updateItem = function (item) {
    if (item.k === "result") {
      this.onResult(item);
      return;
    }
    if (item.agent != null) {
      this.agentStep(item);
      return;
    }
    if (item.k === "notice") {
      const old = this.notices.get(item.id);
      if (old != null) {
        const fresh = this.noticeEl(item);
        old.replaceWith(fresh);
      }
    } else if (item.k === "text") {
      const tv = this.textViews.get(item.id);
      if (tv != null) {
        tv.update();
      }
    } else if (item.k === "tool") {
      const entry = this.rows.get(item.id);
      if (entry != null) {
        entry.row.changed();
        this.touch(entry.work);
      }
      const card = this.cards.get(item.id);
      if (card != null) {
        card.refresh();
      }
    } else if (item.k === "thinking") {
      const entry = this.rows.get(item.id);
      if (entry == null) {
        return;
      }
      if (item.partial !== true && !CC.Store.isStep(item)) {
        entry.work.removeRow(entry.row);
        this.rows.delete(item.id);
        if (entry.work.isEmpty() && this.builder.work === entry.work) {
          this.builder.work = null;
        }
      } else {
        entry.row.changed();
        this.touch(entry.work);
      }
    }
  };

  Flow.prototype.setMode = function (mode) {
    this.mode = mode;
    this.root.dataset.mode = mode;
    const done = new Set();
    this.rows.forEach(function (entry) {
      if (!done.has(entry.work)) {
        done.add(entry.work);
        entry.work.applyMode(mode);
      }
    });
    this.changed();
  };

  // At the very end, give or take a rounded pixel: the flow follows the stream only from here.
  Flow.prototype.atBottom = function () {
    const s = this.scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight < AT_END_PX;
  };

  Flow.prototype.release = function () {
    this.following = false;
    this.pinned = false;
  };

  // The user moving up lets go of the latest, even a pixel. A viewport that changed size or content that got shorter moves the position by itself.
  Flow.prototype.notePosition = function () {
    const s = this.scroller;
    const top = s.scrollTop;
    const height = s.clientHeight;
    const content = s.scrollHeight;
    const movedUp = top < (this.lastTop || 0) && height === this.lastHeight && content >= this.lastContent && height > 0;
    this.lastTop = top;
    this.lastHeight = height;
    this.lastContent = content;
    if (movedUp) {
      this.release();
    }
    return movedUp;
  };

  Flow.prototype.sticky = function () {
    this.notePosition();
    return this.following || this.pinned;
  };

  Flow.prototype.scrollToBottom = function (smooth) {
    const s = this.scroller;
    if (s.scrollTo != null) {
      s.scrollTo({ top: s.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    } else {
      s.scrollTop = s.scrollHeight;
    }
    if (!smooth) {
      this.lastTop = s.scrollTop;
      this.lastContent = s.scrollHeight;
    }
  };

  // What's on screen, deepest element first, each with where it stood. Its own kind of scroll anchoring: WebKit has none, and Chromium's is off
  // (overflow-anchor in the CSS) so both behave alike.
  Flow.prototype.notePlace = function () {
    const s = this.scroller;
    this.place = [];
    if (s.clientHeight === 0) {
      return;
    }
    const top = s.getBoundingClientRect().top;
    const scrollTop = s.scrollTop;
    let at = this.log;
    for (let depth = 0; depth < PLACE_DEPTH && at != null; depth++) {
      let hit = null;
      for (let c = at.firstElementChild; c != null && hit == null; c = c.nextElementSibling) {
        if (c.getClientRects().length > 0 && c.getBoundingClientRect().bottom > top) {
          hit = c;
        }
      }
      if (hit == null) {
        break;
      }
      this.place.unshift({ node: hit, y: hit.getBoundingClientRect().top + scrollTop });
      at = PLACE_LEAF.test(hit.tagName) ? null : hit;
    }
  };

  // Content above what the user reads changed height: move by as much. y counts from the top of the content, so the user's own scrolling cancels out.
  Flow.prototype.holdPlace = function () {
    const s = this.scroller;
    if (s.clientHeight === 0) {
      return;
    }
    const mark = (this.place || []).find(function (m) {
      return m.node.isConnected && m.node.getClientRects().length > 0;
    });
    if (mark != null) {
      const shift = mark.node.getBoundingClientRect().top + s.scrollTop - mark.y;
      if (Math.abs(shift) >= 0.5) {
        s.scrollTop += shift;
        this.lastTop = s.scrollTop;
      }
    }
    this.notePlace();
  };

  Flow.prototype.render = function (items) {
    if (items.length === 0) {
      return;
    }
    if (this.hold != null) {
      this.unbuilt = this.unbuilt.concat(items);
      return;
    }
    let shown = items;
    if (this.log.childNodes.length === 0 && this.unbuilt.length === 0) {
      const at = turnsStart(items, WINDOW_TURNS);
      if (at > 0) {
        this.leaveUnbuilt(items.slice(0, at));
        shown = items.slice(at);
      }
    }
    const stick = this.sticky();
    for (const item of shown) {
      try {
        this.builder.add(item);
      } catch (e) {
        console.error("render failed", item.k, e);
      }
    }
    this.flush();
    this.updateEmpty();
    if (stick) {
      this.scrollToBottom(false);
    } else {
      this.fresh = true;
      this.unseen += shown.filter(function (it) {
        return (it.k === "text" || (it.k === "user" && !it.command)) && it.agent == null;
      }).length;
    }
    this.onScroll();
  };

  // Older than all that's built. A subagent's steps count at once: the row that shows them reads them when it's built, in the order they came.
  Flow.prototype.leaveUnbuilt = function (items) {
    const self = this;
    this.unbuilt = items.concat(this.unbuilt);
    items.forEach(function (item) {
      if (item.agent != null) {
        self.agentStep(item);
      }
    });
    this.syncOlder();
  };

  Flow.prototype.syncOlder = function () {
    const has = this.store.hasOlder === true || this.unbuilt.length > 0;
    if (has !== this.hasOlder) {
      this.hasOlder = has;
      this.updateOlder();
    }
  };

  Flow.prototype.renderOlder = function (items) {
    this.leaveUnbuilt(items);
    if (this.hold == null) {
      this.buildChunk();
    }
  };

  // The next turns up, as many as it takes for something to show.
  Flow.prototype.buildChunk = function () {
    const before = this.log.childNodes.length;
    while (this.unbuilt.length > 0 && this.log.childNodes.length === before) {
      this.buildFrom(turnsStart(this.unbuilt, CHUNK_TURNS));
    }
  };

  // Everything up to the turn of the newest item that passes, in one go. False if none does.
  Flow.prototype.buildThrough = function (test) {
    if (this.hold != null) {
      return false;
    }
    for (let i = this.unbuilt.length - 1; i >= 0; i--) {
      if (test(this.unbuilt[i])) {
        while (i > 0 && (this.unbuilt[i].k !== "user" || this.unbuilt[i].agent != null)) {
          i -= 1;
        }
        this.buildFrom(i);
        return true;
      }
    }
    return false;
  };

  // Find searches the DOM, so it needs all of it.
  Flow.prototype.buildAll = function () {
    if (this.hold == null && this.unbuilt.length > 0) {
      this.buildFrom(0);
    }
  };

  Flow.prototype.buildFrom = function (at) {
    const items = this.unbuilt.slice(at);
    this.unbuilt = this.unbuilt.slice(0, at);
    const frag = document.createDocumentFragment();
    const b = new Builder(this, frag);
    for (const item of items) {
      try {
        b.add(item);
      } catch (e) {
        console.error("render failed", item.k, e);
      }
    }
    if (b.turn != null) {
      this.turnFoot(b.turn, null);
    }
    this.flush();
    this.syncOlder();
    const s = this.scroller;
    // "Load earlier messages" may have just gone away, in the same task.
    if (!this.sticky()) {
      this.holdPlace();
    }
    const before = s.scrollHeight;
    const top = s.scrollTop;
    this.log.insertBefore(frag, this.log.firstChild);
    s.scrollTop = top + (s.scrollHeight - before);
    this.updateEmpty();
    this.notePlace();
  };

  // Duration and tokens; cost and the tokens per model on hover. Then the files the turn wrote.
  Flow.prototype.turnFoot = function (turn, item) {
    const self = this;
    turn._items.forEach(function (it) {
      const card = it.k === "tool" ? self.cards.get(it.id) : null;
      if (card != null && !card.ended) {
        card.ended = true;
        card.refresh();
      }
    });
    const user = turn._user;
    if (turn._foot != null || (item == null && (user == null || user.command))) {
      return;
    }
    const store = this.store;
    const stats = store.turnStats(turn._items, user != null ? user.ts : null, item);
    const bits = [];
    if (stats.ms > 0) {
      bits.push(util.fmtDuration(stats.ms));
    }
    const tokens = stats.spend != null ? stats.spend.output : stats.tokens;
    if (tokens > 0) {
      bits.push(util.fmtTokens(tokens) + " tokens");
    }
    const card = this.filesCard(turn, user, stats);
    if (card != null) {
      turn.appendChild(card);
    }
    if (bits.length > 0) {
      const foot = el("div", "cv-foot", bits.join(" · "));
      const tips = [];
      if (stats.end != null) {
        tips.push("Finished " + util.fmtTime(stats.end));
      }
      if (stats.spend != null) {
        tips.push(util.fmtCost(stats.spend.cost), store.spendTitle(stats.spend));
      }
      foot.title = tips.join("\n");
      turn.appendChild(foot);
      turn._foot = foot;
    }
  };

  const FILES_SHOWN = 3;

  // The only recurring card: "Edited 4 files +11 −17", one row per file, Review. Files only Bash may have written are looked up on demand.
  Flow.prototype.filesCard = function (turn, user, stats) {
    const self = this;
    const w = this.store.writtenFiles(turn._items);
    if (w.files.length === 0) {
      return null;
    }
    const counted = w.files.filter(function (f) {
      return f.patch;
    });
    const add = counted.reduce(function (a, f) {
      return a + f.add;
    }, 0);
    const del = counted.reduce(function (a, f) {
      return a + f.del;
    }, 0);
    const created = w.files.every(function (f) {
      return f.status === "added";
    });
    const card = el("div", "cv-files");
    const line = el("div", "cv-files-head");
    const name = w.files.length === 1 ? conv.baseName(w.files[0].path) : w.files.length + " files";
    line.appendChild(el("span", "cv-files-title", (created ? "Created " : "Edited ") + name));
    if (counted.length > 0) {
      line.appendChild(CC.ui.numbers(add, del));
    }
    card.appendChild(line);
    const list = el("div", "cv-files-list");
    card.appendChild(list);
    function row(f, unsure) {
      const r = el("button", "cv-file" + (unsure ? " is-unsure" : ""));
      r.type = "button";
      r.title = f.path + (unsure ? "\nChanged while this turn ran (git status, by modification time): maybe Bash, maybe someone else" : "");
      r.appendChild(el("span", "cv-file-path", util.shortPath(f.path, self.cwd())));
      if (unsure) {
        r.appendChild(el("span", "cv-file-tag", "unsure"));
      }
      if (f.add != null) {
        r.appendChild(CC.ui.numbers(f.add, f.del));
      }
      const chev = el("span", "cc-chev");
      chev.appendChild(CC.ui.icon("chevron", 12));
      r.appendChild(chev);
      r.addEventListener("click", function () {
        CC.bus.emit("path:open", { path: f.path, line: null, chatId: self.env.chatId, cwd: self.cwd() });
      });
      list.appendChild(r);
      return r;
    }
    const foot = el("div", "cv-files-foot");
    const rows = w.files.map(function (f) {
      return row(f, false);
    });
    if (rows.length > FILES_SHOWN + 1) {
      rows.slice(FILES_SHOWN).forEach(function (r) {
        r.hidden = true;
      });
      const more = el("button", "cv-link", "Show " + (rows.length - FILES_SHOWN) + " more");
      more.type = "button";
      more.addEventListener("click", function () {
        rows.forEach(function (r) {
          r.hidden = false;
        });
        more.remove();
      });
      foot.appendChild(more);
    }
    if (this.env.shell != null && this.env.chatId != null && counted.length > 0 && user != null && (user.uuid || user.entryUuid)) {
      const review = el("button", "cv-link", "Review changes");
      review.type = "button";
      review.addEventListener("click", function () {
        self.env.shell.open({ kind: "review", chatId: self.env.chatId, params: { source: "turn:" + (user.uuid || user.entryUuid) } }, { beside: true });
      });
      foot.appendChild(review);
    }
    if (w.bash && user != null) {
      const check = el("button", "cv-link", "Also changed while this ran?");
      check.type = "button";
      check.title = "Bash may have written more: checks git status";
      check.addEventListener("click", function () {
        const note = el("span", "cv-files-note", "Checking git status…");
        check.replaceWith(note);
        const since = conv.tsMs(user.ts);
        self.server().host.call("turnFiles", { cwd: self.cwd() || ".", since: isNaN(since) ? 0 : since, until: stats.end, exclude: w.files.map(function (f) {
          return f.path;
        }) }).then(function (res) {
          (res.files || []).forEach(function (f) {
            row(f, true);
          });
          note.textContent = !res.git ? "Not a git repository: files Bash wrote are not listed" : (res.files || []).length === 0 ? "No other changed files" : "";
        }).catch(function (e) {
          note.textContent = "git status failed: " + (e && e.message ? e.message : e);
        });
      });
      foot.appendChild(check);
    }
    if (foot.childNodes.length > 0) {
      card.appendChild(foot);
    }
    return card;
  };

  Flow.prototype.updateOlder = function () {
    const self = this;
    this.older.textContent = "";
    if (this.hasOlder) {
      const b = el("button", "cv-link", this.loadingOlder ? "Loading…" : "Load earlier messages");
      b.type = "button";
      b.addEventListener("click", function () {
        self.requestOlder();
      });
      this.older.appendChild(b);
    }
  };

  Flow.prototype.requestOlder = async function () {
    if (this.hold != null) {
      return;
    }
    if (this.unbuilt.length > 0) {
      this.buildChunk();
      return;
    }
    await this.loadPage();
  };

  // A page of the transcript from the server.
  Flow.prototype.loadPage = async function () {
    if (!this.hasOlder || this.loadingOlder || this.env.loadOlder == null) {
      return;
    }
    this.loadingOlder = true;
    this.updateOlder();
    try {
      await this.env.loadOlder();
    } catch (e) {
      console.warn("older messages:", e && e.message);
    } finally {
      this.loadingOlder = false;
      this.hasOlder = this.store.hasOlder === true || this.unbuilt.length > 0;
      this.updateOlder();
    }
  };

  Flow.prototype.onScroll = function () {
    if (this.parked || this.restoring) {
      return;
    }
    const height = this.scroller.clientHeight;
    // Built turns come a screen ahead of the reader. Not before there's a screen: a pane not laid out yet is at 0 for no reason.
    const near = this.unbuilt.length > 0 ? (height > 0 ? Math.max(150, height) : 0) : 150;
    if (this.scroller.scrollTop < near && this.hasOlder && this.log.childNodes.length > 0 && !this.cutHidden()) {
      this.requestOlder();
    }
    const movedUp = this.notePosition();
    // First, as a clamp from content that got shorter looks like reaching the end.
    if (!this.following && !this.pinned) {
      this.holdPlace();
    }
    if (!movedUp && this.atBottom()) {
      this.pinned = true;
      this.following = false;
      this.fresh = false;
      this.unseen = 0;
      this.place = null;
    }
    this.changed();
  };

  Flow.prototype.refreshPins = function () {
    const pins = this.env.pins;
    if (pins == null) {
      return;
    }
    this.log.querySelectorAll("[data-mid]").forEach(function (row) {
      row.classList.toggle("is-pinned", pins.has(row.dataset.pin));
    });
  };

  function flash(node) {
    node.classList.remove("cv-flash");
    void node.offsetWidth;
    node.classList.add("cv-flash");
  }

  // The store says whether the item is loaded; older chunks are pulled until it is, or nothing older is left.
  Flow.prototype.jumpTo = async function (id) {
    const self = this;
    const isIt = function (it) {
      return it.id === id || CC.Pins.key(it) === id;
    };
    const loaded = function () {
      return self.store.items.some(isIt);
    };
    await this.holdDone;
    for (let i = 0; !loaded() && this.store.hasOlder === true && i < 50; i++) {
      await this.loadPage();
    }
    this.buildThrough(isIt);
    const row = Array.prototype.find.call(this.log.querySelectorAll("[data-mid]"), function (r) {
      return r.dataset.pin === id || r.dataset.mid === id;
    });
    if (row == null) {
      CC.ui.toast("Message is no longer in this conversation", { level: "error" });
      return;
    }
    this.scrollToNode(row);
    flash(row);
  };

  // A smooth scroll gets where it's going only if no chunk comes in on the way, so those it would meet go in first, and nothing pulls it back to the end for their sake.
  Flow.prototype.scrollToNode = function (node) {
    const room = 2 * this.scroller.clientHeight;
    this.release();
    while (this.unbuilt.length > 0 && node.getBoundingClientRect().top - this.log.getBoundingClientRect().top < room) {
      this.buildChunk();
    }
    if (node.scrollIntoView != null) {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };

  Flow.prototype.reveal = function (node) {
    for (let p = node.parentElement; p != null && p !== this.log; p = p.parentElement) {
      if (p._reveal != null) {
        p._reveal();
      }
    }
    this.scrollToNode(node);
    flash(node);
  };

  // A tool row by tool use id, used by the usage card: older chunks load until it is there, the summary around it opens.
  Flow.prototype.revealTool = async function (tid) {
    await this.holdDone;
    for (let i = 0; this.store.tool(tid) == null && this.store.hasOlder === true && i < 50; i++) {
      await this.loadPage();
    }
    this.buildThrough(function (it) {
      return it.k === "tool" && it.id === tid;
    });
    const entry = this.rows.get(tid);
    if (entry == null) {
      CC.ui.toast("Tool call is no longer in this conversation", { level: "error" });
      return;
    }
    this.reveal(entry.row.root);
  };

  // The newest answer before the prompt's row whose text contains the quote (whitespace ignored, as the selection and
  // the rendered text break lines differently); older chunks load until one does.
  Flow.prototype.revealQuote = async function (quote, before) {
    const self = this;
    const norm = function (s) {
      return s.replace(/[\s*_`#>…-]+/g, "");
    };
    const want = norm(quote);
    const find = function () {
      const rows = self.log.querySelectorAll(".cv-answer");
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (before != null && before.isConnected && !(r.compareDocumentPosition(before) & window.Node.DOCUMENT_POSITION_FOLLOWING)) {
          continue;
        }
        if (norm((r.querySelector(".md") || r).textContent).indexOf(want) >= 0) {
          return r;
        }
      }
      return null;
    };
    await this.holdDone;
    let row = find();
    if (row == null) {
      this.buildAll();
      row = find();
    }
    for (let i = 0; row == null && this.store.hasOlder === true && i < 50; i++) {
      await this.loadPage();
      this.buildAll();
      row = find();
    }
    if (row == null) {
      CC.ui.toast("The quoted reply is no longer in this conversation", { level: "error" });
      return;
    }
    this.reveal(row);
  };

  Flow.prototype.updateEmpty = function () {
    const none = this.log.childNodes.length === 0 && this.sendsBox.childNodes.length === 0;
    let text = "";
    if (none) {
      const rt = this.env.runtime;
      const terminal = rt != null && rt.mode != null && rt.mode() === "terminal";
      text = this.env.emptyText || (this.env.readOnly ? "Nothing here yet." : terminal ? "The conversation shows here as it happens in the terminal tab." : "");
      if (this.startError != null) {
        text = "Claude couldn't start: " + this.startError;
      }
    }
    this.empty.textContent = text;
    this.empty.hidden = !none || text === "";
  };

  // Action row. Copy always; the rest only with a real chat behind the view. What it offers changes with the chat's state and with the final
  // form of a streamed answer, so it can be built again.
  Flow.prototype.actions = function (row, item, who) {
    this.barOf.set(row, { item: item, who: who });
    const old = row.querySelector(":scope > .cv-actions");
    const bar = this.actionBar(row, item, who);
    if (old != null) {
      old.replaceWith(bar);
    } else {
      row.appendChild(bar);
    }
  };

  Flow.prototype.refreshPromptActions = function () {
    const self = this;
    this.log.querySelectorAll(".cv-user").forEach(function (row) {
      const was = self.barOf.get(row);
      if (was != null) {
        self.actions(row, was.item, was.who);
      }
    });
  };

  Flow.prototype.actionBar = function (row, item, who) {
    const self = this;
    const env = this.env;
    const bar = el("div", "cv-actions");
    if (item.ts) {
      bar.appendChild(conv.timeEl(item.ts));
    }
    bar.appendChild(conv.copyButton(function () {
      return item.text;
    }));
    if (env.readOnly !== true && env.runtime != null) {
      const rewindable = who === "user" && CC.Rewind != null && CC.Rewind.available(env.runtime, item);
      if (rewindable) {
        bar.appendChild(conv.action("rewind", "Rewind to here", function () {
          CC.Rewind.open(env.runtime, item);
        }));
      }
      if (item.entryUuid != null || who === "user") {
        bar.appendChild(conv.action("fork", "Fork from here (new chat)", function () {
          self.fork(item);
        }));
      }
      if (rewindable) {
        bar.appendChild(conv.action("pencil", "Edit and resend (stops a running turn)", function () {
          CC.Rewind.edit(env.runtime, item);
        }));
      }
      if (env.pins != null && item.id != null) {
        env.pins.rekey(item);
        row.dataset.mid = item.id;
        row.dataset.pin = CC.Pins.key(item);
        row.classList.toggle("is-pinned", env.pins.has(row.dataset.pin));
        bar.appendChild(conv.action("pin", "Pin message", function () {
          const first = env.pins.list.length === 0;
          row.classList.toggle("is-pinned", env.pins.toggle(item, who));
          if (first && env.shell != null && env.chatId != null) {
            env.shell.open({ kind: "pins", chatId: env.chatId }, { beside: true });
          }
        }));
      }
      if (who === "claude" && env.quote != null) {
        bar.appendChild(conv.action("reply", "Ask a follow-up", function () {
          const flat = item.text.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
          env.quote(flat.length > 160 ? flat.slice(0, 160).replace(/\s\S*$/, "") + "…" : flat);
        }));
      }
    }
    return bar;
  };

  // The conversation an item belongs to: the one a later /clear left, else history before the daemon's first start is
  // in the transcript it started with and the rest in the current one.
  Flow.prototype.conversationOf = function (item) {
    const rt = this.env.runtime;
    const m = this.store.meta;
    if (rt.mirror != null) {
      return m.cliSessionId || null;
    }
    const t = conv.tsMs(item.ts);
    const reset = (m.resets || []).find(function (r) {
      return t < conv.tsMs(r.ts);
    });
    if (reset != null && reset.from != null) {
      return reset.from;
    }
    const first = rt.agent != null ? rt.agent.firstStartTs : null;
    return first != null && t < first ? m.firstCliSessionId || m.cliSessionId : m.cliSessionId;
  };

  Flow.prototype.fork = async function (item) {
    const m = this.store.meta;
    const source = this.conversationOf(item);
    const at = item.entryUuid || item.uuid;
    if (at == null || source == null) {
      CC.ui.toast("This message can't be forked yet", { level: "error" });
      return;
    }
    try {
      const id = await CC.Chats.create({ cwd: this.cwd(), server: this.server().key, model: m.modelId || m.model || null, effort: m.effort || null, permissionMode: m.permissionMode || null,
        fork: { cliSessionId: source, resumeAt: at, parentId: this.env.chatId } });
      if (this.env.shell != null) {
        // A field that has focus by now was gone to while the fork started: it keeps it.
        const active = document.activeElement;
        const typing = active != null && (active.tagName === "TEXTAREA" || active.tagName === "INPUT");
        this.env.shell.open({ kind: "chat", chatId: id }, { beside: true });
        if (typing && active.isConnected) {
          active.focus();
        }
      }
    } catch (e) {
      CC.ui.toast("Fork failed: " + (e && e.message), { level: "error" });
    }
  };

  // The transcript holding an item's images, which after a /clear isn't the chat's current one.
  Flow.prototype.imageFile = function (item) {
    const file = this.env.file != null ? this.env.file() : null;
    const rt = this.env.runtime;
    if (file == null || rt == null || rt.agent == null || rt.mirror != null) {
      return file;
    }
    const sid = this.conversationOf(item);
    return sid != null ? file.replace(/[^/]+\.jsonl$/, sid + ".jsonl") : file;
  };

  // The original of a prompt's image n: the bytes the runtime still has from sending it, else its transcript.
  Flow.prototype.imageFull = function (item) {
    const self = this;
    const rt = this.env.runtime;
    return function (n) {
      const sent = rt != null && rt.originalsOf != null ? rt.originalsOf(item.clientId)[n] : null;
      if (sent != null) {
        return Promise.resolve("data:" + sent.media_type + ";base64," + sent.data);
      }
      return CC.images.load(self.imageFile(item), item.uuid || item.id, n, self.server());
    };
  };

  Flow.prototype.userBubble = function (item) {
    const self = this;
    const rt = this.env.runtime;
    const row = el("div", "cv-user");
    const bubble = el("div", "cv-bubble");
    let shown = item.images > 0 ? item.text.replace(/\[Image #\d+\]\s?/g, "").trim() : item.text;
    const local = item.images > 0 && item.clientId != null && rt != null && rt.previewsOf != null ? rt.previewsOf(item.clientId) : null;
    if (local != null && local.length > 0) {
      bubble.appendChild(CC.images.local(local, item.images, "bubble-thumbs", this.imageFull(item)));
    } else if (item.images > 0) {
      // A prompt we sent has its transcript entry under the uuid the daemon gave it; its own id is the inbox's.
      bubble.appendChild(CC.images.strip(function () {
        return self.imageFile(item);
      }, item.uuid || item.id, item.images));
    }
    const review = item.images > 0 ? null : CC.reviewNote.parse(shown);
    const quoted = review == null ? CC.quote.split(shown) : null;
    if (quoted != null && quoted.quotes.length > 0) {
      shown = quoted.rest;
      quoted.quotes.forEach(function (q) {
        const b = el("button", "cv-bubble-quote");
        b.type = "button";
        b.title = "Jump to the quoted reply";
        b.appendChild(el("span", "cv-bubble-quote-text", q));
        b.addEventListener("click", function () {
          self.revealQuote(q, row);
        });
        bubble.appendChild(b);
      });
    }
    if (review != null) {
      bubble.classList.add("is-review");
      bubble.appendChild(CC.reviewNote.render(review));
    } else if (shown !== "" || !(item.images > 0) && (quoted == null || quoted.quotes.length === 0)) {
      bubble.appendChild(el("div", "cv-bubble-text", shown));
      if (item.text.length > 1200 || item.text.split("\n").length > 18) {
        bubble.classList.add("is-clamped");
        const more = el("button", "cv-link cv-more", "Show more");
        more.type = "button";
        more.addEventListener("click", function () {
          more.textContent = bubble.classList.toggle("is-clamped") ? "Show more" : "Show less";
        });
        bubble.appendChild(more);
      }
    }
    if (item.queued) {
      bubble.appendChild(el("div", "cv-bubble-note", "sent while Claude was working"));
    }
    row.appendChild(bubble);
    this.actions(row, item, "user");
    return row;
  };

  // Slash commands: a divider for /clear, otherwise one quiet card with the command and its output.
  Flow.prototype.commandRow = function (item) {
    if (CLEAR.test(item.text)) {
      const d = this.cutMark("New conversation");
      d.firstChild.title = item.text + (item.ts ? " · " + util.fmtTime(conv.tsMs(item.ts)) : "");
      return d;
    }
    const row = el("div", "cv-cmd");
    row.appendChild(el("code", "cv-cmd-name", item.text));
    return row;
  };

  Flow.prototype.commandOutput = function (row, text) {
    const short = text.split("\n").length <= 2 && text.length < 400;
    const out = short ? CC.markdown.render(text, { cwd: this.cwd() }) : el("pre", null, text);
    out.classList.add("cv-cmd-out");
    row.appendChild(out);
  };

  // Everything before the last cut mark (/clear divider or "Chat cleared") stays collapsed until the mark is clicked.
  Flow.prototype.cutMark = function (text) {
    const self = this;
    const d = el("div", "cv-divider cv-cut");
    const b = el("button", "cv-cut-label");
    b.type = "button";
    const chev = el("span", "cc-chev");
    chev.appendChild(CC.ui.icon("chevron", 12));
    b.append(chev, el("span", null, text));
    b.addEventListener("click", function () {
      if (d.previousElementSibling == null && self.unbuilt.length === 0) {
        return;
      }
      const top = d.getBoundingClientRect().top;
      self.log.classList.toggle("show-cut");
      self.scroller.scrollTop += d.getBoundingClientRect().top - top;
      self.notePlace();
      self.onScroll();
    });
    d.appendChild(b);
    return d;
  };

  Flow.prototype.cutHidden = function () {
    return !this.log.classList.contains("show-cut") && this.log.querySelector(":scope > .cv-cut") != null;
  };

  // Ctrl+K: in the view only.
  Flow.prototype.wipe = function () {
    this.builder.closeTurn();
    this.builder.cmd = null;
    this.log.classList.remove("show-cut");
    this.log.appendChild(this.cutMark("Chat cleared"));
    this.scrollToBottom(false);
    this.onScroll();
  };

  // Streaming text repaints at most every PAINT_MS and not while the page is hidden; CC.markdown.Live keeps the DOM of finished blocks.
  Flow.prototype.answer = function (item) {
    const self = this;
    const row = el("div", "cv-answer" + (item.err ? " is-error" : ""));
    const live = new CC.markdown.Live({ cwd: this.cwd() });
    live.set(item.text, item.partial !== true);
    row.appendChild(live.root);
    row.classList.toggle("is-partial", item.partial === true);
    this.actions(row, item, "claude");
    let forkable = item.entryUuid != null;
    let timer = null;
    let last = 0;
    let rendered = item.text;
    function paint() {
      if (timer != null) {
        self.timers.delete(timer);
        clearTimeout(timer);
      }
      timer = null;
      if (document.hidden || self.parked) {
        self.hiddenViews.add(view);
        if (document.hidden) {
          waiting.add(self);
        }
        return;
      }
      last = Date.now();
      row.classList.toggle("is-partial", item.partial === true);
      if (item.text === rendered && item.partial === true) {
        return;
      }
      rendered = item.text;
      const stick = self.sticky();
      live.cwd = self.cwd();
      live.set(item.text, item.partial !== true);
      if (stick) {
        self.scrollToBottom(false);
      }
      self.changed();
    }
    const view = {
      update: function () {
        if (!forkable && item.entryUuid != null) {
          forkable = true;
          self.actions(row, item, "claude");
        }
        if (item.partial !== true) {
          paint();
        } else if (timer == null) {
          timer = self.later(paint, Math.max(0, last + PAINT_MS - Date.now()));
        }
      },
    };
    this.textViews.set(item.id, view);
    return row;
  };

  Flow.prototype.paintHidden = function () {
    const views = Array.from(this.hiddenViews);
    this.hiddenViews.clear();
    views.forEach(function (v) {
      v.update();
    });
  };

  // Kept by id: a compaction's summary arrives after its notice.
  Flow.prototype.noticeEl = function (item) {
    const node = this.notice(item);
    if (item.id != null) {
      this.notices.set(item.id, node);
    }
    return node;
  };

  Flow.prototype.notice = function (item) {
    if (item.level === "command") {
      const box = el("div", "cv-notice is-command");
      box.appendChild(el("pre", null, item.text));
      return box;
    }
    if (item.level === "compact") {
      const det = el(item.detail ? "details" : "div", "cv-divider");
      det.appendChild(el(item.detail ? "summary" : "span", null, item.text));
      if (item.detail) {
        const d = el("div", "cv-compact-summary");
        d.appendChild(CC.markdown.render(item.detail, { cwd: this.cwd() }));
        det.appendChild(d);
      }
      return det;
    }
    if (item.level === "handback") {
      return this.handback(item);
    }
    const n = el("div", "cv-notice is-" + item.level + (item.status === "failed" ? " is-failed" : ""));
    n.appendChild(el("span", null, item.text));
    if (item.ts) {
      n.title = util.fmtTime(conv.tsMs(item.ts));
    }
    if (item.level !== "error" || (item.hint == null && item.detail == null)) {
      return n;
    }
    const box = el("div", "cv-notice-error");
    box.appendChild(n);
    if (item.hint != null) {
      box.appendChild(CC.markdown.render(item.hint, { cwd: this.cwd() }));
    }
    if (item.detail != null) {
      const det = el("details", "cv-raw");
      det.append(el("summary", null, "Details"), el("pre", null, item.detail));
      box.appendChild(det);
    }
    return box;
  };

  // A subagent's SubagentHandback report, collapsed like the tool work.
  Flow.prototype.handback = function (item) {
    const self = this;
    const d = CC.ui.disclosure({
      label: "Agent report: " + (item.text || this.agentTitle(item.agentId) || "Subagent"),
      body: function (host) {
        const box = el("div", "cv-viewer cv-viewer-md");
        box.appendChild(CC.markdown.render(item.detail || "", { cwd: self.cwd() }));
        host.appendChild(box);
      },
    });
    d.classList.add("cv-handback");
    d._reveal = function () {
      d.setOpen(true);
    };
    return d;
  };

  Flow.prototype.agentTitle = function (agentId) {
    for (const r of this.store.results.values()) {
      if (r.extra != null && r.extra.agentId === agentId) {
        const tool = this.store.tool(r.tid);
        return tool != null && tool.input != null ? tool.input.description || null : null;
      }
    }
    return null;
  };

  // Plans and answered questions stay in the flow on their own. A question still open has C3's card at the end of the flow instead.
  Flow.prototype.standalone = function (item) {
    const self = this;
    const root = el("div", "cv-standalone");
    root.dataset.tid = item.id || "";
    const card = {
      ended: false,
      refresh: function () {
        const result = self.store.resultOf(item.id);
        root.replaceChildren();
        if (result != null || card.ended) {
          root.appendChild(item.name === "ExitPlanMode" ? CC.toolDetail.plan(item, result, self.toolCtx()) : CC.toolDetail.answered(item, result));
        }
        root.hidden = root.childNodes.length === 0;
      },
    };
    card.refresh();
    this.cards.set(item.id, card);
    return root;
  };

  // A selection inside one of Claude's answers shows a Quote button under its end.
  Flow.prototype.bindQuote = function () {
    const self = this;
    const s = this.scroller;
    const btn = el("button", "cv-quote-btn");
    btn.type = "button";
    btn.hidden = true;
    btn.append(CC.ui.icon("quote", 12), document.createTextNode("Quote"));
    this.root.appendChild(btn);
    let text = "";
    function hide() {
      btn.hidden = true;
    }
    function answerOf(node) {
      const e = node != null && node.nodeType === 1 ? node : node != null ? node.parentElement : null;
      const a = e != null ? e.closest(".cv-answer") : null;
      return a != null && self.log.contains(a) ? a : null;
    }
    function check() {
      const sel = window.getSelection();
      if (sel == null || sel.isCollapsed || sel.rangeCount === 0) {
        hide();
        return;
      }
      const range = sel.getRangeAt(0);
      const a = answerOf(range.startContainer);
      text = sel.toString().trim();
      if (a == null || a !== answerOf(range.endContainer) || text === "") {
        hide();
        return;
      }
      const rects = range.getClientRects();
      const end = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
      btn.hidden = false;
      const below = end.bottom + 6 + btn.offsetHeight < s.getBoundingClientRect().bottom;
      btn.style.top = (below ? end.bottom + 6 : (rects.length > 0 ? rects[0] : end).top - btn.offsetHeight - 6) + "px";
      btn.style.left = Math.max(8, Math.min(end.right - btn.offsetWidth / 2, window.innerWidth - btn.offsetWidth - 8)) + "px";
    }
    const onUp = function () {
      self.later(check, 0);
    };
    s.addEventListener("mouseup", onUp);
    s.addEventListener("keyup", check);
    s.addEventListener("scroll", hide, { passive: true });
    const onDown = function (e) {
      if (e.target !== btn && !btn.contains(e.target)) {
        hide();
      }
    };
    s.addEventListener("mousedown", onDown);
    btn.addEventListener("mousedown", function (e) {
      e.preventDefault();
    });
    btn.addEventListener("click", function () {
      if (self.env.quote != null) {
        self.env.quote(text);
      }
      window.getSelection().removeAllRanges();
      hide();
    });
    this.domOffs.push(function () {
      s.removeEventListener("mouseup", onUp);
      s.removeEventListener("keyup", check);
      s.removeEventListener("scroll", hide);
      s.removeEventListener("mousedown", onDown);
      btn.remove();
    });
  };

  // Prompts on their way, not in the store until the daemon takes them. Failed ones are C3's, above the field.
  Flow.prototype.drawSends = function () {
    const self = this;
    const rt = this.env.runtime;
    const rows = (rt != null && rt.sends != null ? rt.sends() : []).filter(function (r) {
      return r.error == null;
    });
    this.sendsBox.replaceChildren();
    rows.forEach(function (r) {
      const row = el("div", "cv-user is-pending");
      const bubble = el("div", "cv-bubble");
      if (r.images > 0) {
        bubble.appendChild(CC.images.local(r.previews, r.images, "bubble-thumbs", self.imageFull({ clientId: r.id, id: r.id })));
      }
      if (r.text || !(r.images > 0)) {
        bubble.appendChild(el("div", "cv-bubble-text", r.text || ""));
      }
      const spin = el("span", "cc-spin cc-spin-quiet cv-send-spin");
      spin.title = "Sending";
      bubble.appendChild(spin);
      row.appendChild(bubble);
      self.sendsBox.appendChild(row);
    });
    this.updateEmpty();
    // Sending goes to the latest; one leaving the list doesn't move anything.
    const grew = rows.length > (this.sendsShown || 0);
    this.sendsShown = rows.length;
    if (grew) {
      this.pinned = true;
      this.scrollToBottom(false);
    }
  };

  return Flow;
})();
