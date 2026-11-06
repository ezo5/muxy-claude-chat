// Last 30 days from the daily ledger (op `ledger`): cost per day and tables by project, model and chat. Chat-mode turns on this server
// only; the answer is kept for a minute.
CC.RailHistory = (function () {
  const util = CC.util;
  const el = util.el;
  const UI = CC.RailUi;
  const DAYS = 30;
  const ROWS = 10;
  const CACHE_MS = 60000;
  let cached = null;
  let cachedAt = 0;
  let cachedFrom = null;

  async function load() {
    const server = CC.Servers.focused();
    if (cached != null && cachedFrom === server.key && Date.now() - cachedAt < CACHE_MS) {
      return cached;
    }
    cachedFrom = server.key;
    cached = await server.host.call("ledger", { days: DAYS });
    cachedAt = Date.now();
    return cached;
  }

  function dayOf(iso) {
    const p = iso.split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function dayLabel(iso, long) {
    return dayOf(iso).toLocaleDateString([], long ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" });
  }

  function tokens(r) {
    return util.fmtTokens(r.input + r.cacheWrite + r.cacheRead) + " in · " + util.fmtTokens(r.output) + " out";
  }

  function turns(n) {
    return n + (n === 1 ? " turn" : " turns");
  }

  function bars(days) {
    const max = days.reduce(function (a, d) {
      return Math.max(a, d.cost);
    }, 0);
    const box = el("div", "cc-hist-chart");
    const read = el("div", "cc-hist-read");
    const plot = el("div", "cc-hist-bars");
    function show(d) {
      read.textContent = d == null ? "" : dayLabel(d.date, true) + " · " + util.fmtCost(d.cost) + " · " + turns(d.turns);
    }
    days.forEach(function (d) {
      const col = el("div", "cc-hist-col");
      const b = el("div", "cc-hist-bar");
      b.style.height = (max > 0 ? Math.max(d.cost > 0 ? 2 : 0, d.cost / max * 100) : 0) + "%";
      col.appendChild(b);
      col.title = dayLabel(d.date, true) + ": " + util.fmtCost(d.cost) + " · " + turns(d.turns);
      col.addEventListener("mouseenter", function () {
        show(d);
      });
      plot.appendChild(col);
    });
    plot.addEventListener("mouseleave", function () {
      show(null);
    });
    const axis = el("div", "cc-hist-axis");
    axis.appendChild(el("span", null, days.length > 0 ? dayLabel(days[0].date) : ""));
    axis.appendChild(el("span", null, max > 0 ? "max " + util.fmtCost(max) : ""));
    axis.appendChild(el("span", null, "Today"));
    box.appendChild(read);
    box.appendChild(plot);
    box.appendChild(axis);
    return box;
  }

  function table(parent, title, rows, more, name, sub) {
    if (rows.length === 0) {
      return;
    }
    const max = rows[0].cost || 1;
    UI.group(parent, title, rows.slice(0, ROWS).map(function (r) {
      const row = UI.shareRow(name(r), r.cost / max, util.fmtCost(r.cost), sub(r));
      row.querySelector(".cc-share-name").title = r.key || name(r);
      return row;
    }));
    const hidden = rows.length - ROWS + (more || 0);
    if (hidden > 0) {
      parent.appendChild(el("div", "cc-rail-note", "+" + hidden + " more"));
    }
  }

  function fill(box, r) {
    box.replaceChildren();
    const t = r.total;
    const head = el("div", "cc-hist-total");
    head.appendChild(el("span", "cc-hist-cost", util.fmtCost(t.cost)));
    head.appendChild(el("span", "cc-rail-note", turns(t.turns) + " · " + tokens(t)));
    box.appendChild(head);
    box.appendChild(bars(r.days || []));
    if (!(t.turns > 0)) {
      box.appendChild(el("div", "cc-rail-note", "No chat turns recorded in the last " + DAYS + " days."));
    }
    UI.fold(box, "By project, model and chat", {}, "history", function (body) {
      table(body, "By project", r.projects || [], r.projectsMore, function (p) {
        return p.key ? util.shortPath(p.key) : p.label;
      }, function (p) {
        return turns(p.turns) + " · " + tokens(p);
      });
      table(body, "By model", r.models || [], r.modelsMore, function (m) {
        return m.label;
      }, function (m) {
        return tokens(m) + " · " + turns(m.turns);
      });
      table(body, "By chat", r.chats || [], r.chatsMore, function (c) {
        return c.label;
      }, function (c) {
        return [c.cwd ? util.shortPath(c.cwd) : null, turns(c.turns), c.lastTs ? "last " + new Date(c.lastTs).toLocaleDateString([], { day: "numeric", month: "short" }) : null]
          .filter(Boolean).join(" · ");
      });
    });
    const notes = ["Chat-mode turns on this server · terminal sessions not included"];
    if (r.skipped > 0) {
      notes.push(r.skipped + " unreadable lines skipped");
    }
    if (r.partial) {
      notes.push("ledger too large, older days partly read");
    }
    box.appendChild(el("div", "cc-rail-note cc-usage-note", notes.join(" · ")));
  }

  // A section that fills itself once the ledger answers.
  function section() {
    const s = UI.section("Last " + DAYS + " days");
    const box = el("div", "cc-usage-body");
    box.appendChild(el("div", "cc-rail-note", "Loading…"));
    s.appendChild(box);
    load().then(function (r) {
      fill(box, r);
    }, function (e) {
      console.warn("ledger failed", e && e.message);
      box.replaceChildren(el("div", "cc-rail-note", "Usage history unavailable: " + (e && e.message)));
    });
    return s;
  }

  return { section: section, DAYS: DAYS };
})();
