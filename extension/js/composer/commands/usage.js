window.CC = window.CC || {};

// `/usage`: get_usage → session cost and the plan limits (5-hour, weekly, per-model weekly) as bars.
CC.Commands.add("usage", async function (ctx) {
  const util = CC.util;
  const el = util.el;
  const card = ctx.card;
  const body = card.open("sparkle", "Usage");
  body.appendChild(el("div", "picker-empty", "Loading…"));
  card.hints([]);
  const root = card.root;
  let r;
  try {
    r = await CC.Commands.control(ctx.composer, "get_usage");
  } catch (e) {
    body.textContent = "";
    body.appendChild(el("div", "picker-empty", "Usage unavailable: " + e.message));
    return;
  }
  if (!root.contains(body)) {
    return;
  }
  body.textContent = "";

  function level(pct) {
    return pct >= 80 ? "hi" : pct >= 50 ? "mid" : "lo";
  }

  function resets(iso) {
    if (!iso) {
      return "";
    }
    const d = new Date(iso);
    const s = (d.getTime() - Date.now()) / 1000;
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const when = d.toDateString() === new Date().toDateString() ? time : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) + " " + time;
    const left = s <= 0 ? "" : s >= 86400 ? Math.floor(s / 86400) + "d " + Math.floor((s % 86400) / 3600) + "h" : Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
    return "resets " + when + (left ? " · in " + left : "");
  }

  function bar(label, pct, foot) {
    const row = el("div", "uc-row");
    const head = el("div", "uc-row-head");
    head.appendChild(el("span", "uc-label", label));
    head.appendChild(el("span", "uc-pct u-t-" + level(pct), Math.round(pct) + "%"));
    const meter = el("span", "u-meter");
    const fill = el("span", "u-fill u-" + level(pct));
    fill.style.width = Math.min(100, Math.max(0, pct)) + "%";
    meter.appendChild(fill);
    const f = el("div", "uc-row-foot");
    f.appendChild(el("span", null, foot));
    row.append(head, meter, f);
    body.appendChild(row);
  }

  const LABELS = { session: "Current session (5-hour)", weekly_all: "Weekly · all models" };
  const limits = Array.isArray(r.limits) ? r.limits : [];
  if (limits.length > 0) {
    limits.forEach(function (l) {
      const scope = l.scope && l.scope.model ? l.scope.model.display_name : null;
      bar(LABELS[l.kind] || (l.group === "weekly" ? "Weekly" : l.kind) + (scope ? " · " + scope : ""), l.percent || 0, resets(l.resets_at));
    });
  } else if (r.rate_limits != null) {
    [["five_hour", "Current session (5-hour)"], ["seven_day", "Weekly · all models"]].forEach(function (k) {
      const w = r.rate_limits[k[0]];
      if (w != null) {
        bar(k[1], w.utilization || 0, resets(w.resets_at));
      }
    });
  } else {
    body.appendChild(el("div", "picker-empty", "No plan limits reported (API key billing?)"));
  }

  const s = r.session || {};
  const grid = el("div", "uc-stats");
  [["Session cost", "$" + (s.total_cost_usd || 0).toFixed(2)], ["Session time", util.fmtDuration(s.total_duration_ms || 0)],
    ["API time", util.fmtDuration(s.total_api_duration_ms || 0)], ["Lines changed", "+" + (s.total_lines_added || 0) + " −" + (s.total_lines_removed || 0)],
    ["Plan", r.subscription_type || "—"]].forEach(function (p) {
    const st = el("div", "uc-stat");
    st.append(el("span", "uc-stat-label", p[0]), el("span", "uc-stat-value", p[1]));
    grid.appendChild(st);
  });
  body.appendChild(grid);
});
