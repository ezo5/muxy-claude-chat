// Small pieces shared by the cards, /usage and the banner: meters against the pace tick, labelled rows, sections, a popover.
CC.RailUi = (function () {
  const el = CC.util.el;
  const PACE_HI = 15; // percentage points over the pace tick that turn a meter red
  const FIVE_H = 5 * 3600;
  const SEVEN_D = 7 * 86400;

  // By pace: amber only once usage passes the elapsed-time tick, red when well past it. Without a tick, by the amount.
  function level(pct, pace) {
    if (pace == null) {
      return pct >= 80 ? "hi" : pct >= 50 ? "mid" : "lo";
    }
    const over = pct - Math.min(100, Math.max(0, pace * 100));
    return over >= PACE_HI ? "hi" : over > 0 ? "mid" : "lo";
  }

  // Part of the window that has passed; null when the reset isn't known.
  function paceOf(reset, windowS) {
    return reset != null ? 1 - (reset - Date.now() / 1000) / windowS : null;
  }

  function meter(pct, pace) {
    const m = el("span", "cc-meter");
    const fill = el("span", "cc-meter-fill is-" + level(pct, pace));
    fill.style.width = Math.min(100, Math.max(0, pct)) + "%";
    m.appendChild(fill);
    if (pace != null) {
      const tick = el("span", "cc-meter-pace");
      tick.style.left = Math.min(100, Math.max(0, pace * 100)) + "%";
      tick.title = "Time elapsed in this window";
      m.appendChild(tick);
    }
    return m;
  }

  function fmtLeft(reset) {
    const s = reset - Date.now() / 1000;
    if (!(s > 0)) {
      return "";
    }
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) {
      return d + "d " + h + "h";
    }
    return h > 0 ? h + "h " + m + "m" : m + "m";
  }

  function fmtResetAt(reset) {
    const d = new Date(reset * 1000);
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? time : d.toLocaleDateString([], { weekday: "short" }) + " " + time;
  }

  // "resets Mon 09:00 · in 4d 5h"
  function resetsText(reset) {
    if (reset == null) {
      return "";
    }
    const left = fmtLeft(reset);
    return "resets " + fmtResetAt(reset) + (left !== "" ? " · in " + left : "");
  }

  function limitRow(label, pct, windowS, reset) {
    const pace = paceOf(reset, windowS);
    const r = el("div", "cc-limit");
    const head = el("div", "cc-limit-head");
    head.appendChild(el("span", "cc-limit-name", label));
    head.appendChild(el("span", "cc-limit-pct is-" + level(pct, pace), Math.round(pct) + "%"));
    r.appendChild(head);
    r.appendChild(meter(pct, pace));
    const foot = resetsText(reset);
    if (foot !== "") {
      r.appendChild(el("div", "cc-limit-foot", foot));
    }
    return r;
  }

  function section(title, extra) {
    const s = el("div", "cc-usage-section");
    const head = el("div", "cc-usage-head");
    head.appendChild(el("h3", "cc-usage-title", title));
    if (extra != null) {
      head.appendChild(extra);
    }
    s.appendChild(head);
    return s;
  }

  // One colour per context category, in the rail's Context card and on /usage's input rows. The hues are the tokens --cat-*.
  const NAMED = { Messages: "messages", "System tools": "tools", "Memory files": "memory", "System prompt": "prompt" };
  const MEMORY_FILE = /(^|\/)(CLAUDE(\.local)?\.md|MEMORY\.md|memory\/)/i;

  // c: a category of get_context_usage. Buffers and deferred ones are the darker grey, free space the darkest.
  function categoryClass(c) {
    if (c.kind === "free") {
      return "is-cat-free";
    }
    if (c.kind === "buffer" || c.kind === "deferred") {
      return "is-cat-quiet";
    }
    return "is-cat-" + (NAMED[c.name] || "rest");
  }

  // r: a row of the session's input spend, under the context category it ends up in by name.
  function spendCategoryClass(r) {
    if (r.kind === "prompt" || r.label === "Assistant messages") {
      return "is-cat-messages";
    }
    if (r.kind === "read" && MEMORY_FILE.test(r.label || "")) {
      return "is-cat-memory";
    }
    if (r.kind === "tool" || r.kind === "read") {
      return "is-cat-tools";
    }
    return /^Session start/.test(r.label || "") ? "is-cat-prompt" : "is-cat-rest";
  }

  // A named value with a share bar: where usage went, spend by model, history tables. opts.note: short secondary text in the name's line; opts.fill: the bar's colour class.
  function shareRow(name, frac, value, sub, actions, opts) {
    const r = el("div", "cc-share");
    const head = el("div", "cc-share-head");
    const label = el("span", "cc-share-name", name);
    label.title = name;
    head.appendChild(label);
    if (opts != null && opts.note) {
      head.appendChild(el("span", "cc-share-note", opts.note));
    }
    (actions || []).forEach(function (a) {
      head.appendChild(a);
    });
    head.appendChild(el("span", "cc-share-value", value));
    r.appendChild(head);
    const bar = el("span", "cc-meter cc-meter-thin");
    const fill = el("span", "cc-meter-fill " + (opts != null && opts.fill ? opts.fill : "is-quiet"));
    fill.style.width = Math.min(100, Math.max(0, frac * 100)) + "%";
    bar.appendChild(fill);
    r.appendChild(bar);
    if (sub) {
      r.appendChild(el("div", "cc-share-sub", sub));
    }
    return r;
  }

  function group(parent, title, rows) {
    if (rows.length === 0) {
      return;
    }
    parent.appendChild(el("div", "cc-usage-group", title));
    rows.forEach(function (r) {
      parent.appendChild(r);
    });
  }

  // What's filled in only if there is something to show, closed until asked. state keeps open folds over the view's repaints.
  function fold(parent, label, state, key, fillIn) {
    const content = document.createDocumentFragment();
    fillIn(content);
    if (content.childNodes.length === 0) {
      return;
    }
    const d = CC.ui.disclosure({
      label: label,
      open: state[key] === true,
      onToggle: function (open) {
        state[key] = open;
      },
      body: content,
    });
    d.classList.add("cc-usage-fold");
    parent.appendChild(d);
  }

  function stats(pairs) {
    const grid = el("div", "cc-stats");
    pairs.forEach(function (p) {
      const s = el("div", "cc-stat");
      s.appendChild(el("span", "cc-stat-label", p[0]));
      s.appendChild(el("span", "cc-stat-value", p[1]));
      grid.appendChild(s);
    });
    return grid;
  }

  // Two or more choices, one on. options: [{value, label}].
  function segmented(options, value, onPick) {
    const seg = el("span", "cc-seg");
    let current = value;
    function paint() {
      Array.from(seg.children).forEach(function (b) {
        b.classList.toggle("is-on", b.dataset.value === current);
        b.setAttribute("aria-pressed", String(b.dataset.value === current));
      });
    }
    options.forEach(function (o) {
      const b = el("button", null, o.label);
      b.type = "button";
      b.dataset.value = o.value;
      b.addEventListener("click", function () {
        current = o.value;
        paint();
        onPick(o.value);
      });
      seg.appendChild(b);
    });
    paint();
    return seg;
  }

  // Floats above its anchor, on the body like every floating thing, and closes itself: outside press, Esc, or the returned closer.
  // build(box, close) → {unmount()}.
  function popover(anchor, build) {
    const root = el("div", "cc-layer");
    const box = el("div", "cc-rail-pop cc-floating");
    box.tabIndex = -1;
    const previous = document.activeElement;
    let handle = null;
    let closed = false;

    function close() {
      if (closed) {
        return;
      }
      closed = true;
      if (handle != null && handle.unmount != null) {
        handle.unmount();
      }
      root.remove();
      if (previous != null && previous.isConnected && previous.focus != null) {
        previous.focus();
      }
    }

    root.addEventListener("pointerdown", function (e) {
      if (e.target === root) {
        close();
      }
    });
    box.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
    root.appendChild(box);
    document.body.appendChild(root);
    handle = build(box, close);
    const at = anchor.getBoundingClientRect();
    const margin = 8;
    box.style.right = Math.max(margin, window.innerWidth - at.right) + "px";
    box.style.bottom = Math.max(margin, window.innerHeight - at.top + 6) + "px";
    box.style.maxHeight = Math.max(160, at.top - 6 - margin) + "px";
    box.focus();
    return close;
  }

  return {
    FIVE_H: FIVE_H, SEVEN_D: SEVEN_D, level: level, paceOf: paceOf, meter: meter, fmtLeft: fmtLeft, resetsText: resetsText, limitRow: limitRow, section: section,
    categoryClass: categoryClass, spendCategoryClass: spendCategoryClass, shareRow: shareRow, group: group, fold: fold, stats: stats, segmented: segmented, popover: popover,
  };
})();
