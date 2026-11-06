// Two sections of /usage: this session's spend (the daemon's `state.spend`) and where plan usage went (get_usage `behaviors`, all
// sessions on this machine).
CC.RailInsights = (function () {
  const util = CC.util;
  const el = util.el;
  const UI = CC.RailUi;
  const KIND_LABEL = { mcp: "MCP", skill: "Skill", read: "Read", agent: "Agent", prompt: "", context: "", tool: "" };
  const INPUT_SHOWN = 10;

  function action(label, run) {
    return CC.ui.chip({ label: label, onClick: function (e) {
      run(e.currentTarget);
    } });
  }

  function mcpOff(model, name) {
    return action("Turn off", function (b) {
      b.disabled = true;
      CC.RailData.mcpOff(model, name).then(function () {
        b.textContent = "Off";
        CC.ui.toast(name + " turned off (/mcp turns it back on)");
      }, function (e) {
        b.disabled = false;
        CC.ui.toast(name + ": " + e.message, { level: "error" });
      });
    });
  }

  // The recommendation's subject sits in its title ("Trim <path>", "Turn off <server> …", "… \"<agent>\" subagents …").
  function recActions(model, rec) {
    const title = rec.title || "";
    let m = /^Trim ((?:~|\/)\S+)/.exec(title);
    if (rec.key === "always_on_context" && m != null) {
      const path = m[1];
      return [action("Open", function () {
        CC.RailData.openPath(path);
      })];
    }
    m = /^Turn off (\S+)/.exec(title);
    if (rec.key === "mcp_server" && m != null) {
      return [mcpOff(model, m[1])];
    }
    m = /"([^"]+)"/.exec(title);
    if (rec.key === "subagent_heavy" && m != null) {
      const name = m[1];
      return [action("Open", function () {
        CC.RailData.openAgentFile(model, name);
      })];
    }
    return [];
  }

  function frontmatter(model) {
    const cu = model.meta().contextUsage;
    return cu != null && cu.skills != null ? cu.skills.skillFrontmatter : null;
  }

  // Into the composer when the caller has one (/usage does); elsewhere the text goes to the clipboard.
  function fixAction(text, model, opts) {
    const b = CC.ui.button({
      label: "Fix with Claude",
      primary: true,
      onClick: function () {
        if (opts.composer != null) {
          opts.composer.setValue(text);
          opts.composer.focus();
          if (opts.onFix != null) {
            opts.onFix();
          }
          return;
        }
        util.copyText(text).then(function (ok) {
          CC.ui.toast(ok ? "Copied. Paste it into the composer." : "Couldn't copy the text", ok ? null : { level: "error" });
        });
      },
    });
    return b;
  }

  function fill(box, b, model, opts) {
    box.replaceChildren();
    const bits = [];
    if (b.request_count != null) {
      bits.push(b.request_count + " requests");
    }
    if (b.session_count != null) {
      bits.push(b.session_count + " sessions");
    }
    if (bits.length > 0) {
      box.appendChild(el("div", "cc-rail-note", bits.join(" · ")));
    }
    UI.group(box, "Recommendations", (b.recommendations || []).map(function (r) {
      return UI.shareRow(r.title || r.key, (r.pct || 0) / 100, (r.pct || 0) + "%", r.detail || "", recActions(model, r));
    }));
    const fix = b.fix != null && Array.isArray(b.fix.messages) ? b.fix.messages[0] : null;
    if (fix) {
      const act = el("div", "cc-usage-act");
      act.appendChild(fixAction(fix, model, opts));
      box.appendChild(act);
    }
    const lists = [
      ["Subagents", b.agents, function (x) {
        return [action("Open", function () {
          CC.RailData.openAgentFile(model, x.name);
        })];
      }],
      ["Skills", b.skills, function (x) {
        return [action("Open", function () {
          CC.RailData.openSkillFile(model, x.name, frontmatter(model));
        })];
      }],
      ["MCP servers", b.mcp_servers, function (x) {
        return [mcpOff(model, x.name)];
      }],
      ["Plugins", b.plugins, null],
    ];
    UI.fold(box, "Subagents, skills, MCP servers, plugins", opts.folds, "where", function (body) {
      lists.forEach(function (l) {
        UI.group(body, l[0], (l[1] || []).map(function (x) {
          return UI.shareRow(x.name, (x.pct || 0) / 100, (x.pct || 0) + "%", "", l[2] != null ? l[2](x) : []);
        }));
      });
    });
    box.appendChild(el("div", "cc-rail-note cc-usage-note", "Approximate · this machine only · shares overlap"));
  }

  // `behaviors` is {day, week}; null when the CLI has none (older versions).
  function behaviors(data, model, opts) {
    const periods = ["day", "week"].filter(function (p) {
      return data != null && data[p] != null;
    });
    if (periods.length === 0) {
      return null;
    }
    let period = periods.indexOf(opts.period) >= 0 ? opts.period : periods[periods.length - 1];
    const box = el("div", "cc-usage-body");
    const seg = UI.segmented(periods.map(function (p) {
      return { value: p, label: p === "day" ? "Day" : "Week" };
    }), period, function (p) {
      period = p;
      opts.onPeriod(p);
      fill(box, data[period], model, opts);
    });
    const s = UI.section("Where your usage went", seg);
    s.appendChild(box);
    fill(box, data[period], model, opts);
    return s;
  }

  function sorted(obj, value) {
    return Object.keys(obj || {}).map(function (k) {
      return { key: k, row: obj[k], value: value(obj[k]) };
    }).filter(function (x) {
      return x.value > 0;
    }).sort(function (a, b) {
      return b.value - a.value;
    });
  }

  function tokenSub(r) {
    return util.fmtTokens(r.input + r.cacheWrite + r.cacheRead) + " in (" + util.fmtTokens(r.cacheRead) + " cached) · " + util.fmtTokens(r.output) + " out";
  }

  function byModel(s, sp) {
    const models = sorted(sp.models, function (m) {
      return m.cost || m.input + m.cacheWrite + m.cacheRead + m.output;
    });
    const max = models.length > 0 ? models[0].value : 1;
    UI.group(s, "By model", models.map(function (x) {
      const m = x.row;
      const extra = [];
      if (m.thinking > 0) {
        extra.push(util.fmtTokens(m.thinking) + " thinking");
      }
      if (m.write1h > 0 || m.write5m > 0) {
        extra.push("writes " + util.fmtTokens(m.write5m) + " 5m / " + util.fmtTokens(m.write1h) + " 1h");
      }
      if (m.webSearch > 0 || m.webFetch > 0) {
        extra.push(m.webSearch + " searches, " + m.webFetch + " fetches");
      }
      return UI.shareRow(x.key, x.value / max, util.fmtCost(m.cost), [tokenSub(m), m.calls + " calls"].concat(extra).join(" · "));
    }));
  }

  // The first consumers; the rest, and what every call reads again, on demand.
  function inputAdded(s, sp, cwd, folds) {
    const tools = sorted(sp.tools, function (r) {
      return r.tokens;
    });
    const added = tools.reduce(function (a, x) {
      return a + x.value;
    }, 0) || 1;
    const rows = tools.map(function (x) {
      const r = x.row;
      const kind = KIND_LABEL[r.kind] || "";
      const name = r.kind === "read" ? util.shortPath(r.label, cwd) : r.label;
      return UI.shareRow(name, x.value / added, util.fmtTokens(r.tokens), "", [], { note: (kind ? kind + " · " : "") + r.count + (r.count === 1 ? " time" : " times"), fill: UI.spendCategoryClass(r) });
    });
    UI.group(s, "Input added by", rows.slice(0, INPUT_SHOWN));
    const rest = rows.slice(INPUT_SHOWN);
    if (sp.total.cacheRead > 0) {
      rest.push(UI.shareRow("Context carried (cache reads)", 0, util.fmtTokens(sp.total.cacheRead), "the same context read again by every call"));
    }
    const label = rows.length > INPUT_SHOWN ? rows.length - INPUT_SHOWN + " more" + (sp.total.cacheRead > 0 ? ", context carried" : "") : "Context carried";
    UI.fold(s, label, folds, "input", function (body) {
      rest.forEach(function (r) {
        body.appendChild(r);
      });
    });
  }

  function subagents(s, sp) {
    const agents = sorted(sp.agents, function (a) {
      return a.input + a.cacheWrite + a.cacheRead + a.output;
    });
    const max = agents.length > 0 ? agents[0].value : 1;
    UI.group(s, "Subagents", agents.map(function (x) {
      const a = x.row;
      return UI.shareRow(x.key, x.value / max, util.fmtTokens(x.value), tokenSub(a) + " · " + a.runs + (a.runs === 1 ? " run" : " runs") + ", " + a.calls + " calls");
    }));
  }

  function hotResults(s, sp, cwd, onShow) {
    const hot = sp.hot || [];
    UI.group(s, "Large tool results", hot.map(function (h) {
      const name = (h.tool || "").indexOf("mcp__") === 0 ? h.tool.split("__").slice(1).join(" · ") : h.tool === "Read" ? util.shortPath(h.label, cwd) : h.label;
      const actions = onShow != null ? [action("Show", function () {
        onShow(h.id);
      })] : [];
      return UI.shareRow(name, h.tokens / Math.max(1, hot[0].tokens), util.fmtTokens(h.tokens), "", actions);
    }));
  }

  // opts: {cwd, onShow(toolId), folds}; without onShow there's no jump. Null before the first turn.
  function session(sp, opts) {
    if (sp == null || sp.total == null || !(sp.total.turns > 0)) {
      return null;
    }
    const t = sp.total;
    const input = t.input + t.cacheWrite + t.cacheRead;
    const total = el("span", "cc-usage-total");
    total.append(el("span", "cc-usage-total-value", util.fmtCost(t.cost)), el("span", "cc-rail-note", t.turns + (t.turns === 1 ? " turn" : " turns")));
    const s = UI.section("This session", total);
    s.appendChild(UI.stats([["Cache hits", input > 0 ? Math.round(t.cacheRead / input * 100) + "%" : "—"], ["Cache reads", util.fmtTokens(t.cacheRead)],
      ["Cache writes", util.fmtTokens(t.cacheWrite)], ["Uncached input", util.fmtTokens(t.input)]]));
    inputAdded(s, sp, opts.cwd, opts.folds);
    UI.fold(s, "Models, subagents, large tool results", opts.folds, "session", function (body) {
      byModel(body, sp);
      subagents(body, sp);
      hotResults(body, sp, opts.cwd, opts.onShow);
    });
    s.appendChild(el("div", "cc-rail-note cc-usage-note", "Input added is estimated from cache writes between calls"));
    return s;
  }

  return { behaviors: behaviors, session: session };
})();
