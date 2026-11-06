// Find over one view: matches are DOM ranges painted with the CSS Custom Highlight API, so streaming re-renders never fight with inserted
// marks. Highlight names are page-wide while each pane has its own instance, so the registry is painted from the union of all open finds.
CC.Find = (function () {
  const el = CC.util.el;
  const HL = typeof CSS !== "undefined" && CSS.highlights != null && typeof Highlight === "function";
  const open = new Set();

  function paintAll(name) {
    if (!HL) {
      return;
    }
    const rest = [];
    const current = [];
    open.forEach(function (f) {
      if (f.opts.highlight === name) {
        const cur = f.cur >= 0 ? f.matches[f.cur] : null;
        f.matches.forEach(function (r) {
          (r === cur ? current : rest).push(r);
        });
      }
    });
    CSS.highlights.set(name, new Highlight(...rest));
    CSS.highlights.set(name + "-current", new Highlight(...current));
  }

  // opts: scroller, root (searched element), mount (bar parent), roots (selector of searchable nodes), placeholder, highlight (CSS highlight
  // name), prepare(q) (unfold hidden content), bottom(), horizontal (the scroller also scrolls sideways). Whoever owns the view calls open().
  function Find(opts) {
    const self = this;
    this.opts = opts;
    this.scroller = opts.scroller;
    this.matches = [];
    this.cur = -1;
    this.timer = 0;
    this.bar = el("div", "cv-find");
    this.bar.hidden = true;
    this.input = el("input", "cv-find-input");
    this.input.type = "text";
    this.input.placeholder = opts.placeholder;
    this.input.spellcheck = false;
    this.count = el("span", "cv-find-count");
    const button = function (icon, label, fn) {
      const b = CC.ui.iconButton({ icon: icon, label: label, size: 14, onClick: fn });
      return b;
    };
    this.bar.append(this.input, this.count, button("up", "Previous match (Shift+Enter)", function () {
      self.step(-1);
    }), button("chevronDown", "Next match (Enter)", function () {
      self.step(1);
    }), button("x", "Close (Esc)", function () {
      self.close();
    }));
    opts.mount.appendChild(this.bar);
    this.input.addEventListener("input", function () {
      self.run(true);
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
    open.add(this);
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
    open.delete(this);
    paintAll(this.opts.highlight);
    if (this.opts.onClose != null) {
      this.opts.onClose();
    }
  };

  Find.prototype.dispose = function () {
    clearTimeout(this.timer);
    this.timer = 0;
    this.matches = [];
    open.delete(this);
    paintAll(this.opts.highlight);
    this.bar.remove();
  };

  // New or re-rendered items while open: matches are recomputed, the current one kept by its text position.
  Find.prototype.refresh = function () {
    const self = this;
    if (!this.isOpen() || this.input.value === "" || this.timer !== 0) {
      return;
    }
    this.timer = setTimeout(function () {
      self.timer = 0;
      self.run(false);
    }, 150);
  };

  Find.prototype.collect = function (q) {
    const out = [];
    const needle = q.toLowerCase();
    if (this.opts.prepare != null) {
      this.opts.prepare(needle);
    }
    this.opts.root.querySelectorAll(this.opts.roots).forEach(function (root) {
      const walk = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT);
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
    this.count.textContent = this.input.value === "" || !this.isOpen() ? "" : n === 0 ? "No results" : (this.cur + 1) + "/" + n;
    this.bar.classList.toggle("is-empty", this.input.value !== "" && n === 0);
    paintAll(this.opts.highlight);
  };

  // Unfolds whatever hides the current match: closed details, clamped bubbles, anything with a `_reveal()`.
  Find.prototype.reveal = function () {
    const r = this.matches[this.cur];
    if (r == null) {
      return;
    }
    const node = r.startContainer.parentElement;
    for (let p = node; p != null && p !== this.opts.root; p = p.parentElement) {
      if (p.tagName === "DETAILS" && !p.open) {
        p.open = true;
      } else if (p.classList.contains("is-clamped")) {
        p.querySelector(".cv-more").click();
      } else if (p._reveal != null) {
        p._reveal();
      }
    }
    const rect = r.getBoundingClientRect();
    const box = this.scroller.getBoundingClientRect();
    const bottom = this.opts.bottom != null ? this.opts.bottom() : 0;
    if (rect.top < box.top + 64 || rect.bottom > box.bottom - bottom - 16) {
      this.scroller.scrollTop = this.scroller.scrollTop + rect.top - box.top - box.height / 3;
    }
    if (this.opts.horizontal === true && (rect.left < box.left + 60 || rect.right > box.right - 16)) {
      this.scroller.scrollLeft += rect.left - box.left - box.width / 3;
    }
  };

  return Find;
})();
