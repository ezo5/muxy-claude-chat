// One composer per chat pane: the field, and a small plugin bus. Features live in sibling files and call CC.Composer.use(fn); each plugin
// runs once per instance, so all its state is per pane. The chat's own state stays in ChatRuntime and kv `session:<sid>`.
// One instance spreads over four chat slots: `flowEnd`, `aboveComposer`, `composer`, `belowComposer` (slots.js).
CC.Composer = (function () {
  const util = CC.util;
  const el = util.el;
  const plugins = [];
  const byCtx = new WeakMap();
  const byPane = new Map();
  const byRoot = new WeakMap();
  const MAC = /mac|iphone|ipad/i.test(navigator.platform || "");
  const MOD = MAC ? "⌘" : "Ctrl+";
  const SAY_MS = 6000;

  Object.assign(CC.icons, {
    shield: '<path d="M20 13c0 5-3.500 7.500-7.660 8.950a1 1 0 0 1-.670-.010C7.500 20.500 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.500-1.200 6.240-2.720a1.170 1.170 0 0 1 1.520 0C14.510 3.810 17 5 19 5a1 1 0 0 1 1 1z"/>',
    play: '<path d="M6 4l14 8-14 8z"/>',
    quote: '<path d="M10 7H5v6h4c0 2-1 3-3 4"/><path d="M20 7h-5v6h4c0 2-1 3-3 4"/>',
  });

  function Composer(ctx) {
    this.ctx = ctx;
    this.runtime = ctx.runtime;
    this.handlers = {};
    this.disposers = [];
    this.disposed = false;
    this.refs = 0;
    this.status = "connecting";
    this.statusDetail = null;
    this.meta = {};
    this.pending = [];
    this.suggestion = null;
    this.saying = null;
    this.deps = this.makeDeps();
    this.buildDom();
    this.bind();
    const self = this;
    plugins.forEach(function (p) {
      p(self);
    });
    ["state", "mode", "change"].forEach(function (name) {
      self.onDispose(self.runtime.on(name, function () {
        self.sync();
      }));
    });
    this.sync();
    this.autosize();
    // A pane mounts before it's in the page, where a restored draft measures as nothing. Only a new width measures again, so the height set here can't loop.
    if (typeof ResizeObserver === "function") {
      let width = this.input.clientWidth;
      const ro = new ResizeObserver(function () {
        if (self.input.clientWidth !== width) {
          width = self.input.clientWidth;
          self.autosize();
        }
      });
      ro.observe(this.input);
      this.onDispose(function () {
        ro.disconnect();
      });
    }
  }

  // The instance of a pane, created by the first slot that mounts.
  Composer.forPane = function (ctx) {
    if (ctx.runtime == null) {
      return null;
    }
    let c = byCtx.get(ctx);
    if (c == null) {
      c = new Composer(ctx);
      byCtx.set(ctx, c);
      byPane.set(ctx.paneId, c);
    }
    return c;
  };

  // For other surfaces: `CC.Composer.ofPane(paneId).addQuote(text)`.
  Composer.ofPane = function (paneId) {
    return byPane.get(paneId) || null;
  };

  // The composer showing this chat, if one does; the focused pane's when two do.
  Composer.of = function (chatId) {
    const focused = CC.Shell.focused();
    if (focused != null && focused.chatId === chatId && byPane.has(focused.id)) {
      return byPane.get(focused.id);
    }
    for (const c of byPane.values()) {
      if (c.ctx.chatId === chatId) {
        return c;
      }
    }
    return null;
  };

  // For key bindings: the composer whose field this event happened in.
  Composer.ofField = function (target) {
    const root = target.closest != null ? target.closest(".cmp") : null;
    const c = root != null ? byRoot.get(root) : null;
    return c != null && c.input === target ? c : null;
  };

  Composer.use = function (plugin) {
    plugins.push(plugin);
  };

  Composer.MOD = MOD;

  Composer.prototype.buildDom = function () {
    // aboveComposer
    this.above = el("div", "cmp-above");
    this.aboveQueue = el("div");
    this.commandHost = el("div");
    this.chips = el("div", "cmp-chips");
    this.above.append(this.aboveQueue, this.commandHost, this.chips);
    // composer
    this.root = el("div", "cmp");
    byRoot.set(this.root, this);
    this.box = el("div", "cmp-box");
    this.left = el("div", "cmp-tools");
    this.right = el("div", "cmp-tools");
    this.input = el("textarea", "cmp-input");
    this.input.rows = 1;
    this.input.spellcheck = true;
    this.input.setAttribute("aria-label", "Message Claude");
    this.box.append(this.left, this.input, this.right);
    this.popupHost = el("div", "cmp-popup-host");
    this.root.append(this.popupHost, this.box);
    // belowComposer
    this.below = el("div", "cmp-below");
    this.belowLeft = el("div", "cmp-below-group");
    this.hint = el("span", "cmp-hint");
    this.hint.setAttribute("role", "status");
    this.belowRight = el("div", "cmp-below-group");
    this.below.append(this.belowLeft, this.hint, this.belowRight);
    // flowEnd
    this.flowEnd = el("div", "cmp-flow-end");

    const self = this;
    this.sendBtn = CC.ui.iconButton({
      icon: "send",
      label: "Send",
      onClick: function () {
        if (self.isWorking()) {
          self.deps.interrupt();
        } else {
          self.submit(false);
        }
      },
    });
    this.sendBtn.classList.add("cmp-send");
    this.right.appendChild(this.sendBtn);
  };

  Composer.prototype.makeDeps = function () {
    const rt = this.runtime;
    const self = this;
    return {
      interrupt: function () {
        Promise.resolve(rt.interrupt()).catch(function (e) {
          CC.ui.toast("Interrupt failed: " + e.message, { level: "error" });
        });
      },
      respond: function (requestId, behavior, extra) {
        return rt.respond(requestId, behavior, extra);
      },
      control: function (subtype, payload) {
        return rt.control(subtype, payload);
      },
      files: async function (q) {
        const res = await CC.Servers.of(rt).host.call("files", { cwd: self.cwd(), q: q });
        return res.files || [];
      },
    };
  };

  Composer.prototype.cwd = function () {
    return this.meta.cwd || this.runtime.cwd || ".";
  };

  Composer.prototype.on = function (name, fn) {
    (this.handlers[name] = this.handlers[name] || []).push(fn);
  };

  Composer.prototype.emit = function (name, arg) {
    const list = this.handlers[name] || [];
    for (const fn of list) {
      if (fn(arg) === true) {
        return true;
      }
    }
    return false;
  };

  Composer.prototype.onDispose = function (fn) {
    this.disposers.push(fn);
  };

  Composer.prototype.button = function (iconName, label, onClick) {
    return CC.ui.iconButton({
      icon: iconName,
      label: label,
      onClick: function (e) {
        e.preventDefault();
        onClick(e);
      },
    });
  };

  Composer.prototype.bind = function () {
    const self = this;
    this.input.addEventListener("input", function () {
      self.autosize();
      self.emit("input");
      self.refresh();
    });
    this.input.addEventListener("keydown", function (e) {
      if (e.isComposing) {
        return;
      }
      if (self.emit("keydown", e)) {
        e.preventDefault();
      }
    });
    this.box.addEventListener("click", function (e) {
      if (e.target === self.box) {
        self.input.focus();
      }
    });
  };

  Composer.prototype.autosize = function () {
    const ta = this.input;
    ta.style.height = "auto";
    const max = Math.max(120, Math.floor(window.innerHeight * 0.45));
    ta.style.height = Math.min(ta.scrollHeight, max) + "px";
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  };

  Composer.prototype.isWorking = function () {
    return this.status === "busy" || this.status === "waiting";
  };

  Composer.prototype.canSendNow = function () {
    return this.status === "idle";
  };

  // A card in the flow is waiting for an answer: what's typed here must not go to Claude in place of it.
  Composer.prototype.cardWaits = function () {
    return this.pending.length > 0;
  };

  Composer.prototype.value = function () {
    return this.input.value;
  };

  Composer.prototype.setValue = function (text, caretAtStart) {
    this.input.value = text;
    const pos = caretAtStart ? 0 : text.length;
    this.input.setSelectionRange(pos, pos);
    this.autosize();
    this.emit("input", { programmatic: true });
    this.refresh();
  };

  Composer.prototype.insertAtCaret = function (text) {
    const ta = this.input;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.setSelectionRange(s + text.length, s + text.length);
    this.autosize();
    this.emit("input");
    this.refresh();
  };

  Composer.prototype.focus = function () {
    this.input.focus();
  };

  // For what isn't a request to write here: takes focus only if it is nowhere, so never from another field, and only in the focused pane.
  Composer.prototype.focusIfNowhere = function () {
    const active = document.activeElement;
    const pane = CC.Shell.focused();
    if ((active == null || active === document.body) && pane != null && pane.id === this.ctx.paneId) {
      this.focus();
    }
  };

  Composer.prototype.collect = function () {
    const entry = { id: util.uid(), text: this.input.value.replace(/\s+$/, ""), images: [], createdAt: Date.now() };
    this.emit("collect", entry);
    return entry;
  };

  Composer.prototype.submit = function (forceNow) {
    if (this.emit("beforeSubmit")) {
      return;
    }
    const entry = this.collect();
    if (entry.text.trim() === "" && entry.images.length === 0) {
      return;
    }
    if (entry.blocked) {
      CC.ui.toast(entry.blocked);
      return;
    }
    this.emit("submitted", entry);
    this.setValue("");
    this.dispatch(entry, forceNow);
    this.focus();
  };

  // Sends now, or queues. With a card waiting it always queues, also when asked to force: a prompt sent past an open question gets lost.
  Composer.prototype.dispatch = function (entry, forceNow) {
    if (this.cardWaits()) {
      this.emit("enqueue", entry);
      this.say("Queued, it goes out once you've answered the card above");
    } else if (forceNow || this.canSendNow()) {
      this.emit("send", entry);
    } else {
      this.emit("enqueue", entry);
      this.startIfStopped();
    }
  };

  // There's no Start button: writing to a stopped chat brings it back, and the queue delivers once it's idle.
  Composer.prototype.startIfStopped = function () {
    const rt = this.runtime;
    if (this.status === "stopped" && rt != null && rt.restart != null && rt.mode() === "chat") {
      rt.restart({}).catch(function (e) {
        console.warn("chat not resumed", e && e.message);
      });
    }
  };

  // A short sentence in the row under the field, in place of the hint.
  Composer.prototype.say = function (text) {
    const self = this;
    this.saying = text;
    clearTimeout(this.sayTimer);
    this.sayTimer = setTimeout(function () {
      self.saying = null;
      self.refresh();
    }, SAY_MS);
    this.refresh();
  };

  // Everything the views read comes through here, whichever event told us it changed.
  Composer.prototype.sync = function () {
    const rt = this.runtime;
    this.meta = rt.meta() || {};
    this.emit("meta", this.meta);
    this.setStatus(rt.mode() === "terminal" ? "terminal" : rt.status(), rt.store.statusDetail);
    this.pending = rt.store.pending || [];
    if (this.pending.length === 0) {
      this.saying = null;
    }
    this.emit("pending", this.pending);
    this.refresh();
  };

  Composer.prototype.setStatus = function (status, detail) {
    const prev = this.status;
    this.statusDetail = detail;
    if (status === prev) {
      return;
    }
    this.status = status;
    this.root.dataset.status = status;
    this.input.disabled = status === "terminal";
    // A disabled field can't hold focus, so back from the terminal there is none.
    if (prev === "terminal") {
      this.focusIfNowhere();
    }
    this.emit("status", { status: status, prev: prev, detail: detail });
  };

  Composer.prototype.hasAttachments = function () {
    return this.chips.querySelector(".cmp-chip") != null;
  };

  Composer.prototype.refresh = function () {
    const working = this.isWorking();
    const hasContent = this.input.value.trim() !== "" || this.hasAttachments();
    if (this.sendBtn.classList.contains("is-stop") !== working) {
      this.sendBtn.replaceChildren(CC.ui.icon(working ? "stop" : "send"));
      this.sendBtn.classList.toggle("is-stop", working);
    }
    this.sendBtn.disabled = !working && !hasContent;
    const label = working ? "Stop" : this.canSendNow() ? "Send" : "Add to queue";
    this.sendBtn.title = working ? "Interrupt Claude (Esc, Ctrl+C)" : label + " (Enter)";
    this.sendBtn.setAttribute("aria-label", label);
    this.hint.classList.toggle("is-saying", this.saying != null);
    this.hint.textContent = this.saying != null ? this.saying : this.hintFor(hasContent);
    this.input.placeholder = this.placeholderFor();
  };

  Composer.prototype.hintFor = function (hasContent) {
    if (hasContent && this.cardWaits()) {
      return "↵ adds to queue, sent after you answer";
    }
    if (hasContent && !this.canSendNow()) {
      return "↵ adds to queue · " + MOD + "↵ sends now";
    }
    if (!hasContent && this.status === "idle" && this.suggestion != null) {
      return "⇥ or → accepts the suggestion";
    }
    return "";
  };

  Composer.prototype.placeholderFor = function () {
    if (this.status === "terminal") {
      return "Terminal mode, type in the terminal tab";
    }
    if (this.cardWaits() || this.status === "waiting") {
      return "Answer above, or queue a message";
    }
    if (this.status === "busy") {
      return "Claude is working, queue a message";
    }
    if (this.status === "stopped") {
      return "Claude is stopped, a message starts it again";
    }
    if (this.status === "starting" || this.status === "connecting") {
      return "Starting Claude";
    }
    return this.suggestion != null ? this.suggestion : "Message Claude, / for commands";
  };

  Composer.prototype.retain = function () {
    this.refs += 1;
  };

  Composer.prototype.release = function () {
    this.refs -= 1;
    if (this.refs === 0) {
      this.dispose();
    }
  };

  Composer.prototype.dispose = function () {
    this.disposed = true;
    clearTimeout(this.sayTimer);
    this.disposers.forEach(function (fn) {
      fn();
    });
    this.disposers = [];
    if (byPane.get(this.ctx.paneId) === this) {
      byPane.delete(this.ctx.paneId);
    }
    byCtx.delete(this.ctx);
    if (this.runtime.composer === this) {
      this.runtime.composer = null;
    }
  };

  return Composer;
})();
