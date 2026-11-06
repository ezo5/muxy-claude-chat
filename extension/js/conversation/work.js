// A run of tool work between two pieces of prose. Level 1: one grey summary line. Level 2: a quiet list of intent rows. Level 3: a row
// opens in place, its detail built on first open. View mode lives in a data attribute on the view: CSS shows thinking rows in Thinking and
// Verbose, setMode opens everything in Verbose and remembers what the user opened by hand.
CC.Work = (function () {
  const el = CC.util.el;
  const REPAINT_MS = 70;

  function whenSeen(node, fn) {
    if (typeof IntersectionObserver !== "function") {
      fn();
      return;
    }
    const io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) {
        io.disconnect();
        fn();
      }
    }, { rootMargin: "400px" });
    io.observe(node);
  }

  function Row(view, item) {
    this.view = view;
    this.item = item;
    this.root = el("div", "cv-step");
    this.root.dataset.tid = item.id || "";
    this.root.dataset.tool = item.name || "";
    this.head = el("button", "cv-step-head");
    this.head.type = "button";
    this.label = el("span", "cv-step-label");
    this.meta = el("span", "cv-step-meta");
    const chev = el("span", "cc-chev");
    chev.appendChild(CC.ui.icon("chevron", 12));
    this.head.append(this.label, this.meta, chev);
    this.root.appendChild(this.head);
    this.body = null;
    this.userOpen = false;
    this.timer = 0;
    const self = this;
    this.head.addEventListener("click", function () {
      self.userOpen = !self.isOpen();
      self.setOpen(self.userOpen);
    });
    this.paint();
  }

  Row.prototype.isOpen = function () {
    return this.root.classList.contains("is-open");
  };

  Row.prototype.setOpen = function (open) {
    this.root.classList.toggle("is-open", open);
    this.head.setAttribute("aria-expanded", String(open));
    if (open) {
      this.fill();
    }
  };

  Row.prototype.fill = function () {
    const fresh = CC.toolDetail.detail(this.item, this.view.store.resultOf(this.item.id), this.view.toolCtx());
    if (this.body != null) {
      this.body.replaceWith(fresh);
    } else {
      this.root.appendChild(fresh);
    }
    this.body = fresh;
  };

  Row.prototype.paint = function () {
    const result = this.view.store.resultOf(this.item.id);
    const l = CC.toolDetail.label(this.item, result, this.view.toolCtx());
    this.label.textContent = "";
    if (l.verb) {
      this.label.appendChild(document.createTextNode(l.verb));
    }
    if (l.name) {
      this.label.appendChild(document.createTextNode(l.verb ? " " : ""));
      this.label.appendChild(el("b", null, l.name));
    }
    if (l.text) {
      this.label.appendChild(document.createTextNode((l.verb ? " " : "") + l.text));
    }
    if (l.code) {
      this.label.appendChild(document.createTextNode(l.verb ? " " : ""));
      this.label.appendChild(el("code", null, l.code));
    }
    this.head.title = l.tip;
    this.meta.textContent = "";
    if (l.add != null) {
      this.meta.appendChild(CC.ui.numbers(l.add, l.del));
    }
    if (l.note) {
      this.meta.appendChild(el("span", "cv-step-note", l.note));
    }
    if (l.failed) {
      this.meta.appendChild(el("span", "cv-failed", "Failed"));
    }
    this.root.classList.toggle("is-running", result == null);
    this.root.classList.toggle("is-failed", l.failed);
  };

  // The label follows at once; an open detail at most every REPAINT_MS while the input streams.
  Row.prototype.changed = function () {
    this.paint();
    if (!this.isOpen() || this.timer !== 0) {
      return;
    }
    const self = this;
    this.timer = setTimeout(function () {
      self.timer = 0;
      if (self.isOpen()) {
        self.fill();
      }
    }, REPAINT_MS);
  };

  Row.prototype.applyMode = function (mode) {
    if (mode !== "verbose") {
      this.setOpen(this.userOpen);
    } else if (!this.isOpen()) {
      const self = this;
      this.root.classList.add("is-open");
      whenSeen(this.root, function () {
        if (self.isOpen() && self.body == null) {
          self.fill();
        }
      });
    }
  };

  // A thinking row: the label and latest line under the summary, the whole text when opened.
  function ThinkingRow(view, item) {
    this.view = view;
    this.item = item;
    this.root = el("div", "cv-step cv-think");
    this.head = el("button", "cv-step-head");
    this.head.type = "button";
    this.label = el("span", "cv-think-label");
    this.preview = el("span", "cv-think-preview");
    const chev = el("span", "cc-chev");
    chev.appendChild(CC.ui.icon("chevron", 12));
    this.head.append(this.label, this.preview, chev);
    this.text = el("div", "cv-think-text");
    this.text.hidden = true;
    this.root.append(this.head, this.text);
    this.frame = 0;
    this.userOpen = false;
    const self = this;
    this.head.addEventListener("click", function () {
      self.userOpen = !self.root.classList.contains("is-open");
      self.setOpen(self.userOpen);
    });
    this.paint();
  }

  ThinkingRow.prototype.setOpen = function (open) {
    this.root.classList.toggle("is-open", open);
    this.head.setAttribute("aria-expanded", String(open));
    this.text.hidden = !open;
  };

  ThinkingRow.prototype.paint = function () {
    const item = this.item;
    const lines = (item.text || "").split("\n").map(function (l) {
      return l.replace(/[*_`#>]+/g, "").trim();
    }).filter(Boolean);
    this.label.textContent = item.partial === true ? "Thinking" : CC.Store.thinkingLabel(item);
    this.preview.textContent = lines.length > 0 ? lines[lines.length - 1] : "";
    this.text.textContent = item.text || "";
    this.root.classList.toggle("is-empty", !item.text);
  };

  ThinkingRow.prototype.changed = function () {
    const self = this;
    if (this.frame === 0) {
      this.frame = (typeof requestAnimationFrame === "function" ? requestAnimationFrame : setTimeout)(function () {
        self.frame = 0;
        self.paint();
      });
    }
  };

  ThinkingRow.prototype.applyMode = function (mode) {
    this.setOpen(mode === "verbose" || this.userOpen);
  };

  function Work(view) {
    this.view = view;
    this.items = [];
    this.rows = [];
    this.userOpen = false;
    this.root = el("div", "cv-work");
    this.root._reveal = this.reveal.bind(this);
    this.line = el("button", "cv-work-line");
    this.line.type = "button";
    this.lineLabel = el("span", "cv-work-label");
    this.lineMeta = el("span", "cv-work-meta");
    const chev = el("span", "cc-chev");
    chev.appendChild(CC.ui.icon("chevron", 12));
    this.line.append(this.lineLabel, this.lineMeta, chev);
    this.list = el("div", "cv-work-list");
    this.root.append(this.line, this.list);
    const self = this;
    this.line.addEventListener("click", function () {
      self.userOpen = !self.root.classList.contains("is-open");
      self.setOpen(self.userOpen);
    });
    this.setOpen(view.mode === "verbose");
  }

  Work.prototype.setOpen = function (open) {
    this.root.classList.toggle("is-open", open);
    this.line.setAttribute("aria-expanded", String(open));
  };

  Work.prototype.reveal = function () {
    this.userOpen = true;
    this.setOpen(true);
  };

  Work.prototype.addTool = function (item) {
    const row = new Row(this.view, item);
    this.push(item, row);
    return row;
  };

  Work.prototype.addThinking = function (item) {
    const row = new ThinkingRow(this.view, item);
    this.push(item, row);
    return row;
  };

  Work.prototype.push = function (item, row) {
    this.items.push(item);
    this.rows.push(row);
    this.list.appendChild(row.root);
    if (this.view.mode === "verbose") {
      row.applyMode("verbose");
    }
    this.view.touch(this);
  };

  Work.prototype.removeRow = function (row) {
    const at = this.rows.indexOf(row);
    if (at >= 0) {
      this.rows.splice(at, 1);
      this.items.splice(at, 1);
      row.root.remove();
      this.view.touch(this);
    }
  };

  Work.prototype.isEmpty = function () {
    return this.rows.length === 0;
  };

  // A failure stays grey here, red only on its row.
  Work.prototype.refresh = function () {
    const store = this.view.store;
    const resultOf = function (id) {
      return store.resultOf(id);
    };
    const tools = this.items.filter(function (it) {
      return it.k === "tool";
    });
    this.root.classList.toggle("is-thinking-only", tools.length === 0);
    if (tools.length === 0) {
      const t = this.items[0];
      this.lineLabel.textContent = t != null ? CC.Store.thinkingLabel(t) : "";
      this.lineMeta.textContent = "";
      return;
    }
    const failed = store.failedCount(tools);
    this.lineLabel.textContent = CC.toolDetail.summary(tools, resultOf) + (failed > 0 ? ", " + failed + " failed" : "");
    let add = 0;
    let del = 0;
    tools.forEach(function (it) {
      if (CC.toolDetail.kindOf(it, resultOf(it.id)) === "edit" || CC.toolDetail.kindOf(it, resultOf(it.id)) === "create") {
        const n = CC.toolDetail.countLines(CC.toolDetail.hunksOf(it, resultOf(it.id)));
        add += n.add;
        del += n.del;
      }
    });
    this.lineMeta.textContent = "";
    if (add + del > 0) {
      this.lineMeta.appendChild(CC.ui.numbers(add, del));
    }
    this.line.title = CC.conv.plural(tools.length, "call", "calls");
  };

  Work.prototype.applyMode = function (mode) {
    this.setOpen(mode === "verbose" || this.userOpen);
    this.rows.forEach(function (r) {
      r.applyMode(mode);
    });
  };

  return Work;
})();
