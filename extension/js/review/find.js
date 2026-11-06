// Find inside one pane. Matches are DOM ranges painted with the CSS Custom Highlight API, so re-renders never fight with inserted marks.
// Two panes may search at once: there is one Highlight per style, and each Find adds and removes only its own ranges.
CC.ReviewFind = (function () {
  const el = CC.util.el;
  const DEBOUNCE_MS = 150;
  const SHOW_TEXT = 4;

  function highlights() {
    if (typeof CSS === "undefined" || CSS.highlights == null || typeof Highlight !== "function") {
      return null;
    }
    ["cc-rv-find", "cc-rv-find-current"].forEach(function (name) {
      if (!CSS.highlights.has(name)) {
        CSS.highlights.set(name, new Highlight());
      }
    });
    return { all: CSS.highlights.get("cc-rv-find"), current: CSS.highlights.get("cc-rv-find-current") };
  }

  // opts: scroller, root (searched element), mount (bar parent), roots (selector of searchable nodes), placeholder, prepare(needle).
  function Find(opts) {
    const self = this;
    this.opts = opts;
    this.scroller = opts.scroller;
    this.matches = [];
    this.painted = [];
    this.cur = -1;
    this.timer = null;
    this.bar = el("div", "rv-find");
    this.bar.hidden = true;
    this.input = el("input", "rv-find-input");
    this.input.type = "text";
    this.input.placeholder = opts.placeholder;
    this.input.spellcheck = false;
    this.input.setAttribute("aria-label", opts.placeholder);
    this.count = el("span", "rv-find-count");
    const button = function (icon, label, fn) {
      return CC.ui.iconButton({ icon: icon, label: label, size: 14, onClick: fn });
    };
    this.bar.append(CC.ui.icon("search", 14), this.input, this.count, button("up", "Previous match (Shift+Enter)", function () {
      self.step(-1);
    }), button("chevronDown", "Next match (Enter)", function () {
      self.step(1);
    }), button("x", "Close (Esc)", function () {
      self.close();
    }));
    opts.mount.appendChild(this.bar);
    this.input.addEventListener("input", function () {
      self.schedule(true);
    });
    this.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        self.step(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        self.close();
      }
    });
  }

  Find.prototype.isOpen = function () {
    return !this.bar.hidden;
  };

  Find.prototype.open = function () {
    this.bar.hidden = false;
    this.input.focus();
    this.input.select();
    if (this.input.value !== "") {
      this.run(false);
    }
  };

  Find.prototype.close = function () {
    this.bar.hidden = true;
    this.matches = [];
    this.cur = -1;
    this.paint();
  };

  Find.prototype.dispose = function () {
    clearTimeout(this.timer);
    this.close();
  };

  Find.prototype.schedule = function (reveal) {
    const self = this;
    clearTimeout(this.timer);
    this.timer = setTimeout(function () {
      self.timer = null;
      self.run(reveal);
    }, DEBOUNCE_MS);
  };

  // New or re-rendered lines while open: matches are recomputed, the current one kept by its text position.
  Find.prototype.refresh = function () {
    if (this.isOpen() && this.input.value !== "" && this.timer == null) {
      this.schedule(false);
    }
  };

  Find.prototype.collect = function (q) {
    const out = [];
    const needle = q.toLowerCase();
    if (this.opts.prepare != null) {
      this.opts.prepare(needle);
    }
    this.opts.root.querySelectorAll(this.opts.roots).forEach(function (root) {
      const walk = document.createTreeWalker(root, SHOW_TEXT);
      const nodes = [];
      const starts = [];
      let text = "";
      for (let node = walk.nextNode(); node != null; node = walk.nextNode()) {
        nodes.push(node);
        starts.push(text.length);
        text += node.data;
      }
      // Matched over the root's whole text: highlighted code splits words into many text nodes.
      const hay = text.toLowerCase();
      let k = 0;
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
        const end = at + needle.length;
        while (k + 1 < nodes.length && starts[k + 1] <= at) {
          k++;
        }
        let e = k;
        while (e + 1 < nodes.length && starts[e + 1] < end) {
          e++;
        }
        const r = document.createRange();
        r.setStart(nodes[k], at - starts[k]);
        r.setEnd(nodes[e], end - starts[e]);
        out.push(r);
      }
    });
    return out;
  };

  Find.prototype.run = function (reveal) {
    if (!this.isOpen()) {
      return;
    }
    const q = this.input.value;
    const old = this.cur >= 0 ? this.matches[this.cur] : null;
    this.matches = q === "" ? [] : this.collect(q);
    let cur = this.matches.length > 0 ? 0 : -1;
    if (old != null && !reveal) {
      const i = this.matches.findIndex(function (r) {
        return r.startContainer === old.startContainer && r.startOffset === old.startOffset;
      });
      cur = i >= 0 ? i : Math.min(this.cur, this.matches.length - 1);
    } else if (reveal && this.matches.length > 0) {
      cur = this.nearest();
    }
    this.cur = cur;
    this.paint();
    if (reveal) {
      this.reveal();
    }
  };

  // The first match at or below the top of the viewport, so typing does not jump away from what is on screen.
  Find.prototype.nearest = function () {
    const top = this.scroller.getBoundingClientRect().top;
    const i = this.matches.findIndex(function (r) {
      const rect = r.getBoundingClientRect();
      return rect.height > 0 && rect.top >= top;
    });
    return i >= 0 ? i : 0;
  };

  Find.prototype.step = function (d) {
    const n = this.matches.length;
    if (n === 0) {
      return;
    }
    this.cur = (this.cur + d + n) % n;
    this.paint();
    this.reveal();
  };

  Find.prototype.paint = function () {
    const n = this.matches.length;
    this.count.textContent = this.input.value === "" || !this.isOpen() ? "" : n === 0 ? "No results" : (this.cur + 1) + " of " + n;
    const hl = highlights();
    if (hl == null) {
      return;
    }
    this.painted.forEach(function (r) {
      hl.all.delete(r);
      hl.current.delete(r);
    });
    const cur = this.cur >= 0 ? this.matches[this.cur] : null;
    this.matches.forEach(function (r) {
      (r === cur ? hl.current : hl.all).add(r);
    });
    this.painted = this.matches.slice();
  };

  Find.prototype.reveal = function () {
    const r = this.matches[this.cur];
    if (r == null) {
      return;
    }
    const rect = r.getBoundingClientRect();
    const box = this.scroller.getBoundingClientRect();
    if (rect.top < box.top + 48 || rect.bottom > box.bottom - 16) {
      this.scroller.scrollTop += rect.top - box.top - box.height / 3;
    }
    const body = r.startContainer.parentElement != null ? r.startContainer.parentElement.closest(".rv-file-body") : null;
    if (body != null && (rect.left < box.left + 60 || rect.right > box.right - 16)) {
      body.scrollLeft += rect.left - box.left - box.width / 3;
    }
  };

  return Find;
})();
