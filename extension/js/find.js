window.CC = window.CC || {};

// Ctrl/Cmd+F over the transcript or the diff: matches are DOM ranges painted with the CSS Custom Highlight API, so
// streaming markdown re-renders never fight with inserted marks.
CC.Find = (function () {
  const util = CC.util;
  const el = util.el;
  const HL = typeof CSS !== "undefined" && CSS.highlights != null && typeof Highlight === "function";

  // opts: scroller, root (searched element), mount (bar parent), roots (selector of searchable nodes), placeholder,
  // highlight (CSS highlight name), active() (owns Ctrl/Cmd+F now), prepare(q) (unfold hidden content), bottom(),
  // horizontal (the scroller also scrolls sideways).
  function Find(opts) {
    const self = this;
    this.opts = opts;
    this.scroller = opts.scroller;
    this.matches = [];
    this.cur = -1;
    this.timer = 0;
    this.bar = el("div", "find-bar hidden");
    this.input = el("input", "find-input");
    this.input.type = "text";
    this.input.placeholder = opts.placeholder;
    this.input.spellcheck = false;
    this.count = el("span", "find-count");
    const prev = this.button("up", "Previous match (Shift+Enter)", function () {
      self.step(-1);
    });
    const next = this.button("down", "Next match (Enter)", function () {
      self.step(1);
    });
    const close = this.button("x", "Close (Esc)", function () {
      self.close();
    });
    this.bar.append(util.icon("search"), this.input, this.count, prev, next, close);
    opts.mount.insertBefore(this.bar, opts.mount.firstChild);
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
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f" && opts.active()) {
        e.preventDefault();
        self.open();
      }
    });
  }

  Find.prototype.button = function (icon, title, fn) {
    const b = el("button", "icon-btn");
    b.type = "button";
    b.title = title;
    b.appendChild(util.icon(icon));
    b.addEventListener("click", fn);
    return b;
  };

  Find.prototype.isOpen = function () {
    return !this.bar.classList.contains("hidden");
  };

  Find.prototype.open = function () {
    this.bar.classList.remove("hidden");
    this.input.focus();
    this.input.select();
    if (this.input.value !== "") {
      this.run(false);
    }
  };

  Find.prototype.close = function () {
    this.bar.classList.add("hidden");
    this.matches = [];
    this.cur = -1;
    this.paint();
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
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walk.nextNode(); node != null; node = walk.nextNode()) {
        const hay = node.data.toLowerCase();
        for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
          const r = document.createRange();
          r.setStart(node, at);
          r.setEnd(node, at + needle.length);
          out.push(r);
        }
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
    this.bar.classList.toggle("empty", this.input.value !== "" && n === 0);
    if (!HL) {
      return;
    }
    const cur = this.cur >= 0 ? this.matches[this.cur] : null;
    CSS.highlights.set(this.opts.highlight, new Highlight(...this.matches.filter(function (r) {
      return r !== cur;
    })));
    CSS.highlights.set(this.opts.highlight + "-current", cur != null ? new Highlight(cur) : new Highlight());
  };

  // Unfolds whatever hides the current match: folded step groups, closed details, clamped bubbles, elements with a
  // `_reveal()` (tool groups).
  Find.prototype.reveal = function () {
    const r = this.matches[this.cur];
    if (r == null) {
      return;
    }
    const node = r.startContainer.parentElement;
    for (let p = node; p != null && p !== this.opts.root; p = p.parentElement) {
      if (p.classList.contains("steps") && p.classList.contains("folded")) {
        p.classList.remove("folded");
      } else if (p.tagName === "DETAILS" && !p.open) {
        p.open = true;
      } else if (p.classList.contains("bubble") && p.classList.contains("clamped")) {
        p.querySelector(".more-btn").click();
      } else if (p._reveal != null) {
        p._reveal();
      }
    }
    const rect = r.getBoundingClientRect();
    const box = this.scroller.getBoundingClientRect();
    const bottom = this.opts.bottom != null ? this.opts.bottom() : 0;
    if (rect.top < box.top + 48 || rect.bottom > box.bottom - bottom - 16) {
      this.scroller.scrollTo({ top: this.scroller.scrollTop + rect.top - box.top - box.height / 3, behavior: "auto" });
    }
    if (this.opts.horizontal === true && (rect.left < box.left + 60 || rect.right > box.right - 16)) {
      this.scroller.scrollLeft += rect.left - box.left - box.width / 3;
    }
  };

  return Find;
})();
