window.CC = window.CC || {};

// Strip under the composer (5h, 7d, session tokens) and the context ring in the toolbar; each opens its card. Data:
// get_context_usage, rate_limit_event and result.modelUsage from the daemon; the statusline `stats` op only fills what is missing.
CC.Composer.use(function (composer) {
  const util = CC.util;
  const el = util.el;
  const POLL_MS = 15000;
  const FIVE_H = 5 * 3600;
  const SEVEN_D = 7 * 86400;

  let stats = null;
  let open = false;
  let ctxOpen = false;

  const strip = el("button", "usage-strip");
  strip.type = "button";
  strip.title = "Usage details";
  composer.box.appendChild(strip);

  const card = el("div", "usage-card hidden");
  composer.above.appendChild(card);

  const ring = el("button", "tb-btn ctx-ring hidden");
  ring.type = "button";
  composer.left.appendChild(ring);
  const ctxCard = el("div", "usage-card ctx-card hidden");
  composer.above.appendChild(ctxCard);

  strip.addEventListener("click", function () {
    open = !open;
    ctxOpen = false;
    render();
  });
  ring.addEventListener("click", function (e) {
    e.preventDefault();
    ctxOpen = !ctxOpen;
    open = false;
    render();
  });
  document.addEventListener("mousedown", function (e) {
    if (open && !card.contains(e.target) && !strip.contains(e.target)) {
      open = false;
      render();
    }
    if (ctxOpen && !ctxCard.contains(e.target) && !ring.contains(e.target)) {
      ctxOpen = false;
      render();
    }
  });
  document.addEventListener("keydown", function (e) {
    if ((open || ctxOpen) && e.key === "Escape") {
      open = false;
      ctxOpen = false;
      render();
    }
  });

  function level(pct) {
    if (pct >= 80) {
      return "hi";
    }
    return pct >= 50 ? "mid" : "lo";
  }

  function fmtLeft(resetTs) {
    const s = resetTs - Date.now() / 1000;
    if (!(s > 0)) {
      return "—";
    }
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) {
      return d + "d " + h + "h";
    }
    return h > 0 ? h + "h " + m + "m" : m + "m";
  }

  function fmtResetAt(resetTs) {
    const d = new Date(resetTs * 1000);
    const sameDay = d.toDateString() === new Date().toDateString();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return sameDay ? time : d.toLocaleDateString([], { weekday: "short" }) + " " + time;
  }

  // Input counts cached tokens too; the statusline totals cover terminal mode, where no result events arrive.
  function tokenTotals() {
    const t = composer.meta.tokens;
    if (t == null) {
      const p = stats && stats.status ? stats.status.payload : null;
      const cw = p && p.context_window;
      if (cw == null || cw.total_input_tokens == null) {
        return null;
      }
      return { input: cw.total_input_tokens || 0, output: cw.total_output_tokens || 0 };
    }
    const s = t.sum;
    return { input: s[0] + s[1] + s[2], fresh: s[0], write: s[1], read: s[2], output: s[3] };
  }

  function tokenTitle(t) {
    let title = "Tokens in this session: " + util.fmtTokens(t.input + t.output) + "\nInput: " + util.fmtTokens(t.input);
    if (t.read != null) {
      title += " (" + util.fmtTokens(t.read) + " cache read, " + util.fmtTokens(t.write) + " cache write, " + util.fmtTokens(t.fresh) + " uncached)";
    }
    return title + "\nOutput: " + util.fmtTokens(t.output);
  }

  function fmtDur(ms) {
    return util.fmtDuration(ms);
  }

  function limits() {
    const rlm = composer.meta.rateLimit;
    const w = rlm != null ? rlm.unifiedWindows : null;
    if (w != null && w.five_hour != null && w.seven_day != null) {
      return {
        five: { pct: (w.five_hour.utilization || 0) * 100, reset: w.five_hour.resetsAt },
        seven: { pct: (w.seven_day.utilization || 0) * 100, reset: w.seven_day.resetsAt },
      };
    }
    const p = stats && stats.status ? stats.status.payload : null;
    const rl = p && p.rate_limits;
    if (rl && rl.five_hour && rl.seven_day) {
      return {
        five: { pct: rl.five_hour.used_percentage, reset: rl.five_hour.resets_at },
        seven: { pct: rl.seven_day.used_percentage, reset: rl.seven_day.resets_at },
      };
    }
    const u = stats && stats.usage;
    if (u && u.ok && u.five_h && u.seven_d) {
      return {
        five: { pct: u.five_h.pct, reset: u.five_h.reset },
        seven: { pct: u.seven_d.pct, reset: u.seven_d.reset },
      };
    }
    return null;
  }

  function context() {
    const cu = composer.meta.contextUsage;
    if (cu != null && cu.maxTokens) {
      return { pct: cu.percentage != null ? cu.percentage : Math.round((cu.totalTokens / cu.maxTokens) * 100), used: cu.totalTokens || 0, size: cu.maxTokens };
    }
    const p = stats && stats.status ? stats.status.payload : null;
    const cw = p && p.context_window;
    if (cw && cw.context_window_size) {
      const cu = cw.current_usage || {};
      const used = (cu.input_tokens || 0) + (cu.cache_read_input_tokens || 0) + (cu.cache_creation_input_tokens || 0);
      return { pct: cw.used_percentage || 0, used: used, size: cw.context_window_size };
    }
    const tokens = composer.meta.contextTokens;
    if (!tokens) {
      return null;
    }
    const size = /opus-5|opus-4-[678]|fable-5|sonnet-5|mythos|\[1m\]/.test(composer.meta.modelId || "") ? 1000000 : 200000;
    return { pct: Math.round((tokens / size) * 100), used: tokens, size: size };
  }

  function meter(pct, pace) {
    const m = el("span", "u-meter");
    const fill = el("span", "u-fill u-" + level(pct));
    fill.style.width = Math.min(100, Math.max(0, pct)) + "%";
    m.appendChild(fill);
    if (pace != null) {
      const tick = el("span", "u-pace");
      tick.style.left = Math.min(100, Math.max(0, pace * 100)) + "%";
      tick.title = "Time elapsed in this window";
      m.appendChild(tick);
    }
    return m;
  }

  function pace(reset, windowS) {
    return 1 - (reset - Date.now() / 1000) / windowS;
  }

  function chip(label, pct, extra, paceVal, tip) {
    const c = el("span", "u-chip");
    c.title = tip || "";
    c.appendChild(el("span", "u-label", label));
    c.appendChild(meter(pct, paceVal));
    c.appendChild(el("span", "u-val u-t-" + level(pct), Math.round(pct) + "%"));
    if (extra) {
      c.appendChild(el("span", "u-extra", extra));
    }
    return c;
  }

  function renderStrip() {
    strip.textContent = "";
    const ctx = context();
    const lim = limits();
    if (ctx == null && lim == null && !composer.meta.model) {
      strip.classList.add("hidden");
      return;
    }
    strip.classList.remove("hidden");
    const m = composer.meta;
    const p0 = stats && stats.status ? stats.status.payload : null;
    if (m.model) {
      const model = el("span", "u-model", m.model);
      const effort = (p0 && p0.effort ? p0.effort.level : null) || m.effort;
      if (effort) {
        model.appendChild(el("span", "u-effort", effort));
      }
      model.title = util.modelLabel(m, effort) + (m.gitBranch ? "\nBranch: " + m.gitBranch : "");
      strip.appendChild(model);
    }
    if (lim != null) {
      strip.appendChild(chip("Usage", lim.five.pct, "resets in " + fmtLeft(lim.five.reset), pace(lim.five.reset, FIVE_H),
        "5-hour limit: " + Math.round(lim.five.pct) + "% used, resets in " + fmtLeft(lim.five.reset)));
    }
    const tok = tokenTotals();
    if (tok != null && tok.input + tok.output > 0) {
      const t = el("span", "u-tokens");
      t.appendChild(el("span", "u-label", "Session"));
      t.appendChild(el("span", "u-total", util.fmtTokens(tok.input + tok.output) + " tokens"));
      t.appendChild(el("span", "u-extra", "↑" + util.fmtTokens(tok.input) + " ↓" + util.fmtTokens(tok.output)));
      t.title = tokenTitle(tok);
      strip.appendChild(t);
    }
  }

  function row(label, pct, main, sub, paceVal) {
    const r = el("div", "uc-row");
    const head = el("div", "uc-row-head");
    head.appendChild(el("span", "uc-label", label));
    head.appendChild(el("span", "uc-pct u-t-" + level(pct), Math.round(pct) + "%"));
    r.appendChild(head);
    r.appendChild(meter(pct, paceVal));
    const foot = el("div", "uc-row-foot");
    foot.appendChild(el("span", null, main));
    foot.appendChild(el("span", null, sub));
    r.appendChild(foot);
    return r;
  }

  function sparkline(history) {
    const pts = history.filter(function (h) {
      return h.five != null;
    });
    if (pts.length < 2) {
      return null;
    }
    const t0 = pts[0].ts;
    const span = Math.max(1, pts[pts.length - 1].ts - t0);
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 100 30");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "uc-spark");
    [["five", "uc-spark-five"], ["seven", "uc-spark-seven"]].forEach(function (k) {
      const line = document.createElementNS(ns, "polyline");
      line.setAttribute("points", pts.map(function (h) {
        return ((h.ts - t0) / span * 100).toFixed(2) + "," + (30 - Math.min(100, h[k[0]] || 0) * 0.3).toFixed(2);
      }).join(" "));
      line.setAttribute("class", k[1]);
      line.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(line);
    });
    return svg;
  }

  function stat(label, value) {
    const s = el("div", "uc-stat");
    s.appendChild(el("span", "uc-stat-label", label));
    s.appendChild(el("span", "uc-stat-value", value));
    return s;
  }

  function renderCard() {
    card.classList.toggle("hidden", !open);
    strip.classList.toggle("active", open);
    if (!open) {
      return;
    }
    card.textContent = "";
    const p = stats && stats.status ? stats.status.payload : null;
    const head = el("div", "uc-head");
    const model = (p && p.model && p.model.display_name) || composer.meta.model || "Claude";
    head.appendChild(el("span", "uc-title", model));
    const bits = [];
    if (p && p.effort && p.effort.level) {
      bits.push(p.effort.level);
    }
    if (stats && stats.usage && stats.usage.plan) {
      bits.push(stats.usage.plan);
    }
    head.appendChild(el("span", "uc-sub", bits.join(" · ")));
    card.appendChild(head);

    const ctx = context();
    if (ctx != null) {
      card.appendChild(row("Context window", ctx.pct, util.fmtTokens(ctx.used) + " of " + util.fmtTokens(ctx.size) + " tokens",
        util.fmtTokens(Math.max(0, ctx.size - ctx.used)) + " left"));
    }
    const lim = limits();
    if (lim != null) {
      card.appendChild(row("5-hour limit", lim.five.pct, "resets " + fmtResetAt(lim.five.reset), "in " + fmtLeft(lim.five.reset), pace(lim.five.reset, FIVE_H)));
      card.appendChild(row("Weekly limit", lim.seven.pct, "resets " + fmtResetAt(lim.seven.reset), "in " + fmtLeft(lim.seven.reset), pace(lim.seven.reset, SEVEN_D)));
    }

    const tok = tokenTotals();
    if (p || tok != null) {
      const grid = el("div", "uc-stats");
      if (p && p.cost) {
        grid.appendChild(stat("Session time", fmtDur(p.cost.total_duration_ms || 0)));
        grid.appendChild(stat("API time", fmtDur(p.cost.total_api_duration_ms || 0)));
        grid.appendChild(stat("Lines changed", "+" + (p.cost.total_lines_added || 0) + " −" + (p.cost.total_lines_removed || 0)));
      }
      if (tok != null) {
        grid.appendChild(stat("Input tokens", util.fmtTokens(tok.input)));
        grid.appendChild(stat("Output tokens", util.fmtTokens(tok.output)));
      }
      if (p && p.prompt_cache && p.prompt_cache.hit_ratio != null) {
        grid.appendChild(stat("Cache hits", Math.round(p.prompt_cache.hit_ratio * 100) + "%"));
        grid.appendChild(stat("Cache", p.prompt_cache.warm ? "warm · " + (p.prompt_cache.ttl || "") : "cold"));
      }
      card.appendChild(grid);
    }

    const spark = stats ? sparkline(stats.history || []) : null;
    if (spark != null) {
      const box = el("div", "uc-spark-box");
      const legend = el("div", "uc-spark-legend");
      legend.appendChild(el("span", "uc-key uc-key-five", "5-hour"));
      legend.appendChild(el("span", "uc-key uc-key-seven", "Weekly"));
      legend.appendChild(el("span", "uc-spark-span", "last 24h"));
      box.appendChild(legend);
      box.appendChild(spark);
      card.appendChild(box);
    }
  }

  function renderRing() {
    const ctx = context();
    ring.classList.toggle("hidden", ctx == null);
    ring.classList.toggle("active", ctxOpen);
    if (ctx == null) {
      return;
    }
    const pct = Math.min(100, Math.max(0, ctx.pct));
    const c = 2 * Math.PI * 7;
    ring.classList.toggle("warn", pct >= 80);
    ring.title = "Context: " + Math.round(ctx.pct) + "% used (" + util.fmtTokens(ctx.used) + " of " + util.fmtTokens(ctx.size) + ")";
    ring.innerHTML = '<svg viewBox="0 0 18 18" class="ctx-svg"><circle cx="9" cy="9" r="7" class="ctx-track"/><circle cx="9" cy="9" r="7" class="ctx-fill"'
      + ' stroke-dasharray="' + (c * pct / 100).toFixed(2) + " " + c.toFixed(2) + '"/></svg>';
  }

  function renderCtxCard() {
    const ctx = context();
    const show = ctxOpen && ctx != null;
    ctxCard.classList.toggle("hidden", !show);
    if (!show) {
      return;
    }
    ctxCard.textContent = "";
    const head = el("div", "uc-head");
    head.appendChild(el("span", "uc-title", "Context window"));
    head.appendChild(el("span", "uc-sub", composer.meta.model || ""));
    ctxCard.appendChild(head);
    ctxCard.appendChild(row("Used", ctx.pct, util.fmtTokens(ctx.used) + " of " + util.fmtTokens(ctx.size) + " tokens",
      util.fmtTokens(Math.max(0, ctx.size - ctx.used)) + " left"));
    const cu = composer.meta.contextUsage;
    const cats = cu != null && Array.isArray(cu.categories) ? cu.categories.filter(function (x) {
      return x.kind === "used" && x.tokens > 0;
    }).sort(function (a, b) {
      return b.tokens - a.tokens;
    }) : [];
    if (cats.length > 0) {
      const grid = el("div", "uc-stats");
      cats.forEach(function (x) {
        grid.appendChild(stat(x.name, util.fmtTokens(x.tokens)));
      });
      ctxCard.appendChild(grid);
    }
    const foot = el("div", "ctx-foot");
    const auto = cu != null && Array.isArray(cu.categories) ? cu.categories.find(function (x) {
      return x.kind === "buffer";
    }) : null;
    foot.appendChild(el("span", "ctx-note", auto != null && ctx.size > 0
      ? "Auto-compacts near " + Math.round((1 - auto.tokens / ctx.size) * 100) + "%" : "/compact summarizes the conversation"));
    const btn = el("button", "chip-btn primary", "Compact now");
    btn.type = "button";
    btn.disabled = composer.status === "terminal";
    btn.addEventListener("click", function () {
      ctxOpen = false;
      render();
      composer.dispatch({ id: util.uid(), text: "/compact", images: [], createdAt: Date.now() }, false);
    });
    foot.appendChild(btn);
    ctxCard.appendChild(foot);
  }

  function render() {
    renderStrip();
    renderCard();
    renderRing();
    renderCtxCard();
  }

  async function poll() {
    if (limits() != null && context() != null && composer.meta.tokens != null) {
      render();
      return;
    }
    try {
      stats = await CC.host.reader("stats", { sessionId: composer.deps.sessionId() });
    } catch (e) {
      console.warn("stats failed", e && e.message);
    }
    render();
  }

  composer.on("meta", function () {
    render();
  });
  composer.on("status", function (s) {
    if (s.prev === "busy" && s.status !== "busy") {
      poll();
    }
  });
  setInterval(poll, POLL_MS);
  setTimeout(poll, 500);
});
