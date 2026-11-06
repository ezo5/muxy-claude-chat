// `CC.Usage.render(el, ctx)`, what /usage shows: plan limits against the pace tick, this session, where usage went, the last 30 days.
// ctx: {runtime, composer?, close?}; composer gets the Fix with Claude text, close is called before leaving for the composer or a tool. get_usage is asked on opening and at most once a minute while open.
CC.Usage = (function () {
  const el = CC.util.el;
  const UI = CC.RailUi;
  const REPORT_MS = 60000;
  const LABELS = { session: "Current session (5-hour)", weekly_all: "Weekly · all models" };
  const WINDOWS = { session: UI.FIVE_H };

  function epoch(value) {
    if (value == null) {
      return null;
    }
    if (typeof value === "number") {
      return value;
    }
    const ms = Date.parse(value);
    return isNaN(ms) ? null : ms / 1000;
  }

  function reportRows(report) {
    const rl = report != null ? report.rate_limits : null;
    const list = rl != null && Array.isArray(rl.limits) ? rl.limits : report != null && Array.isArray(report.limits) ? report.limits : null;
    if (list != null && list.length > 0) {
      return list.map(function (l) {
        const scope = l.scope != null && l.scope.model != null ? l.scope.model.display_name : null;
        return {
          label: LABELS[l.kind] || (l.group === "weekly" ? "Weekly" : l.kind) + (scope ? " · " + scope : ""),
          pct: l.percent || 0, windowS: WINDOWS[l.kind] || UI.SEVEN_D, reset: epoch(l.resets_at),
        };
      });
    }
    if (rl == null) {
      return [];
    }
    return [["five_hour", LABELS.session, UI.FIVE_H], ["seven_day", LABELS.weekly_all, UI.SEVEN_D]].filter(function (k) {
      return rl[k[0]] != null;
    }).map(function (k) {
      return { label: k[1], pct: rl[k[0]].utilization || 0, windowS: k[2], reset: epoch(rl[k[0]].resets_at) };
    });
  }

  function limitRows(report, model) {
    const fromReport = reportRows(report);
    if (fromReport.length > 0) {
      return fromReport;
    }
    const lim = model.limits();
    return lim == null ? [] : [
      { label: LABELS.session, pct: lim.five.pct, windowS: UI.FIVE_H, reset: lim.five.reset },
      { label: LABELS.weekly_all, pct: lim.seven.pct, windowS: UI.SEVEN_D, reset: lim.seven.reset },
    ];
  }

  function limitsSection(report, model, waiting) {
    const plan = report != null && report.subscription_type ? report.subscription_type.charAt(0).toUpperCase() + report.subscription_type.slice(1) + " plan" : null;
    const s = UI.section("Limits", plan != null ? el("span", "cc-rail-note", plan) : null);
    const rows = limitRows(report, model);
    rows.forEach(function (r) {
      s.appendChild(UI.limitRow(r.label, r.pct, r.windowS, r.reset));
    });
    if (rows.length === 0) {
      s.appendChild(el("div", "cc-rail-note", waiting ? "Loading…" : "No plan limits reported (API key billing?)"));
    }
    return s;
  }

  function showTool(ctx) {
    return function (toolId) {
      if (ctx.close != null) {
        ctx.close();
      }
      CC.Conversation.revealTool(ctx.runtime.id, toolId);
    };
  }

  function render(host, ctx) {
    const model = CC.RailData.of(ctx.runtime);
    const release = model.acquire();
    const root = el("div", "cc-usage");
    const live = el("div", "cc-usage-live");
    root.appendChild(live);
    root.appendChild(CC.RailHistory.section());
    host.appendChild(root);

    let report = null;
    let waiting = model.canControl();
    let period = "week";
    let shown = null;
    let timer = null;
    let gone = false;
    const folds = {};

    function paint() {
      const spend = model.meta().spend || null;
      const signature = JSON.stringify([report, spend, model.limits(), waiting]);
      if (signature === shown) {
        return;
      }
      shown = signature;
      const parts = [limitsSection(report, model, waiting)];
      const session = CC.RailInsights.session(spend, { cwd: model.cwd(), onShow: showTool(ctx), folds: folds });
      if (session != null) {
        parts.push(session);
      }
      if (report != null) {
        const where = CC.RailInsights.behaviors(report.behaviors, model, {
          composer: ctx.composer || null,
          onFix: ctx.close || null,
          folds: folds,
          period: period,
          onPeriod: function (p) {
            period = p;
          },
        });
        if (where != null) {
          parts.push(where);
        }
      }
      live.replaceChildren.apply(live, parts);
    }

    async function ask() {
      if (!model.canControl()) {
        waiting = false;
        paint();
        return;
      }
      try {
        report = await model.control("get_usage");
      } catch (e) {
        console.warn("get_usage failed", e && e.message);
      }
      waiting = false;
      if (!gone) {
        paint();
      }
    }

    const off = model.on(paint);
    paint();
    ask();
    timer = setInterval(ask, REPORT_MS);

    return {
      unmount: function () {
        gone = true;
        clearInterval(timer);
        off();
        release();
      },
    };
  }

  return { render: render };
})();
