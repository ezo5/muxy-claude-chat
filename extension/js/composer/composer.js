window.CC = window.CC || {};

// Core composer: textarea, toolbar and a tiny plugin bus. Features live in sibling files and call CC.Composer.use(fn).
CC.Composer = (function () {
  const util = CC.util;
  const el = util.el;
  const plugins = [];

  function Composer(host, deps) {
    this.deps = deps;
    this.handlers = {};
    this.status = "connecting";
    this.meta = {};
    this.pending = [];
    this.root = el("div", "composer");
    this.above = el("div", "composer-above");
    this.box = el("div", "composer-box");
    this.attachRow = el("div", "attach-row");
    this.input = el("textarea", "composer-input");
    this.input.rows = 1;
    this.input.placeholder = "Message Claude…";
    this.input.spellcheck = true;
    this.toolbar = el("div", "composer-toolbar");
    this.left = el("div", "tb-left");
    this.right = el("div", "tb-right");
    this.hint = el("span", "tb-hint");
    this.right.appendChild(this.hint);
    this.toolbar.append(this.left, this.right);
    this.box.append(this.attachRow, this.input, this.toolbar);
    this.popupHost = el("div", "popup-host");
    this.root.append(this.popupHost, this.above, this.box);
    host.appendChild(this.root);
    this.buildButtons();
    this.bind();
    const self = this;
    plugins.forEach(function (p) {
      p(self);
    });
    this.autosize();
    this.refresh();
  }

  Composer.use = function (plugin) {
    plugins.push(plugin);
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

  Composer.prototype.button = function (iconName, title, onClick, cls) {
    const b = el("button", "tb-btn" + (cls ? " " + cls : ""));
    b.type = "button";
    b.title = title;
    b.appendChild(util.icon(iconName));
    b.addEventListener("click", function (e) {
      e.preventDefault();
      onClick(e);
    });
    return b;
  };

  Composer.prototype.buildButtons = function () {
    const self = this;
    this.sendBtn = this.button("send", "Send (Enter)", function () {
      if (self.isWorking()) {
        self.deps.interrupt();
      } else {
        self.submit(false);
      }
    }, "send-btn");
    this.right.appendChild(this.sendBtn);
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
      const handled = self.emit("keydown", e);
      if (handled) {
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        self.submit(e.metaKey || e.ctrlKey);
      } else if (e.key === "Escape" && self.isWorking()) {
        e.preventDefault();
        self.deps.interrupt();
      }
    });
    this.box.addEventListener("click", function (e) {
      if (e.target === self.box || e.target === self.toolbar) {
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
    if (this.emit("focus")) {
      return;
    }
    this.input.focus();
  };

  Composer.prototype.collect = function () {
    const entry = { id: util.uid(), text: this.input.value.replace(/\s+$/, ""), images: [], createdAt: Date.now() };
    this.emit("collect", entry);
    return entry;
  };

  Composer.prototype.submit = function (forceNow) {
    const blocked = this.emit("beforeSubmit");
    if (blocked) {
      return;
    }
    const entry = this.collect();
    if (entry.text.trim() === "" && entry.images.length === 0) {
      return;
    }
    if (entry.blocked) {
      util.toast(entry.blocked);
      return;
    }
    this.emit("submitted", entry);
    this.setValue("");
    this.dispatch(entry, forceNow);
    this.focus();
  };

  Composer.prototype.dispatch = function (entry, forceNow) {
    if (forceNow || this.canSendNow()) {
      Promise.resolve(this.deps.send(entry)).catch(function (e) {
        console.warn("send failed", e && e.message);
      });
    } else {
      this.emit("enqueue", entry);
    }
  };

  Composer.prototype.setStatus = function (status, detail) {
    const prev = this.status;
    this.status = status;
    this.statusDetail = detail;
    this.root.dataset.status = status;
    this.input.disabled = status === "terminal";
    this.emit("status", { status: status, prev: prev, detail: detail });
    this.refresh();
  };

  Composer.prototype.setMeta = function (meta) {
    this.meta = meta || {};
    this.emit("meta", this.meta);
  };

  Composer.prototype.setPending = function (list) {
    this.pending = list || [];
    this.emit("pending", this.pending);
  };

  Composer.prototype.refresh = function () {
    const working = this.isWorking();
    const hasContent = this.input.value.trim() !== "" || this.attachRow.childNodes.length > 0;
    if (this.sendBtn.classList.contains("stop-btn") !== working) {
      this.sendBtn.replaceChild(util.icon(working ? "stop" : "send"), this.sendBtn.firstChild);
      this.sendBtn.classList.toggle("stop-btn", working);
    }
    this.sendBtn.disabled = !working && !hasContent;
    let hint = "";
    if (hasContent && !this.canSendNow()) {
      hint = "↵ adds to queue · ⌘↵ sends now";
    } else if (!hasContent && this.status === "idle") {
      hint = this.suggestion != null ? "⇥ / → accept suggestion" : "/ commands · @ files · ↑ history";
    }
    this.hint.textContent = hint;
    this.sendBtn.title = working ? "Interrupt Claude (Esc, Ctrl+C)" : this.canSendNow() ? "Send (Enter)" : "Add to queue (Enter)";
    this.sendBtn.classList.toggle("queue-mode", !working && !this.canSendNow());
    this.input.placeholder = this.placeholderFor();
  };

  Composer.prototype.placeholderFor = function () {
    if (this.status === "terminal") {
      return "Terminal mode — type in the terminal tab";
    }
    if (this.status === "busy") {
      return "Claude is working — queue a message…";
    }
    if (this.status === "waiting") {
      return "Answer above, or queue a message…";
    }
    if (this.status === "stopped") {
      return "Claude is stopped — messages wait until it starts…";
    }
    if (this.status === "starting" || this.status === "connecting") {
      return "Starting Claude…";
    }
    return this.suggestion != null ? this.suggestion : "Ask Claude anything…";
  };

  return Composer;
})();
