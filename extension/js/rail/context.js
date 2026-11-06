// The Context view, in the rail card and the ring's popover: "8% used · 75k / 1M", a segmented bar, the legend, the drill-down on demand
// (get_context_usage {detail: "full"} calls the token-count API, so it's asked once per opening) and Compact now.
CC.RailContext = (function () {
  const util = CC.util;
  const el = util.el;
  const tok = util.fmtTokens;
  const UI = CC.RailUi;

  function byTokens(a, b) {
    return (b.tokens || 0) - (a.tokens || 0);
  }

  // The live summary goes stale less than a breakdown asked once per opening.
  function usageOf(model) {
    return model.meta().contextUsage || model.full || null;
  }

  // The folded card's line: the number and a tiny bar.
  function statusOf(model) {
    const ctx = model.context();
    if (ctx == null) {
      return null;
    }
    const status = el("span", "cc-cx-status", Math.round(ctx.pct) + "%");
    const bar = el("span", "cc-meter cc-meter-thin");
    const fill = el("span", "cc-meter-fill");
    fill.style.width = Math.min(100, Math.max(0, ctx.pct)) + "%";
    bar.appendChild(fill);
    status.appendChild(bar);
    return status;
  }

  // A category has its colour by name, so it keeps it when sizes change. The bar shows what is in use and the buffer; the rest of it is free space.
  function summary(box, cu, ctx, counts) {
    box.replaceChildren();
    box.appendChild(el("div", "cc-cx-used", Math.round(ctx.pct) + "% used · " + tok(ctx.used) + " / " + tok(ctx.size)));
    const bar = el("div", "cc-cx-bar");
    box.appendChild(bar);
    const categories = cu != null && Array.isArray(cu.categories) ? cu.categories : [];
    const used = categories.filter(function (c) {
      return c.kind === "used" && c.tokens > 0;
    }).sort(byTokens);
    if (used.length === 0) {
      const only = el("span", "cc-cx-seg is-part0");
      only.style.width = Math.min(100, Math.max(0, ctx.pct)) + "%";
      bar.appendChild(only);
      return;
    }
    const size = ctx.size || 1;
    const ofKind = function (kind) {
      return categories.filter(function (c) {
        return c.kind === kind && c.tokens > 0;
      });
    };
    used.concat(ofKind("buffer")).forEach(function (c) {
      const seg = el("span", "cc-cx-seg " + UI.categoryClass(c));
      seg.style.width = (c.tokens / size * 100) + "%";
      seg.title = c.name + ": " + tok(c.tokens);
      bar.appendChild(seg);
    });
    const legend = el("div", "cc-cx-legend");
    used.concat(ofKind("buffer"), ofKind("free")).forEach(function (c) {
      legend.appendChild(legendRow(c, size));
    });
    ofKind("deferred").sort(byTokens).forEach(function (c) {
      legend.appendChild(legendRow(c, size, "Loaded on demand, not in the context yet"));
    });
    box.appendChild(legend);
    const folded = foldedCounts(counts);
    if (folded !== "") {
      box.appendChild(el("div", "cc-cx-folded", folded));
    }
  }

  function legendRow(c, size, tip) {
    const deferred = c.kind === "deferred";
    const row = el("div", "cc-cx-row" + (deferred ? " is-deferred" : ""));
    row.appendChild(el("span", "cc-cx-square " + UI.categoryClass(c)));
    row.appendChild(el("span", "cc-cx-name", c.name));
    row.appendChild(el("span", "cc-cx-tokens", tok(c.tokens)));
    if (!deferred) {
      const pct = c.tokens / size * 100;
      row.appendChild(el("span", "cc-cx-pct", (pct > 0 && pct < 1 ? "<1" : String(Math.round(pct))) + "%"));
    }
    row.title = tip || c.name;
    return row;
  }

  function foldedCounts(cu) {
    const parts = [];
    const mcpTools = cu.mcpTools || [];
    const memory = cu.memoryFiles || [];
    const agents = cu.agents || [];
    if (mcpTools.length > 0) {
      parts.push("MCP tools " + mcpTools.length);
    }
    if (memory.length > 0) {
      parts.push("Memory files " + memory.length);
    }
    if (agents.length > 0) {
      parts.push("Custom agents " + agents.length);
    }
    return parts.join(" · ");
  }

  function footText(cu, ctx) {
    if (cu != null && cu.isAutoCompactEnabled === false) {
      return "Auto-compact is off";
    }
    let threshold = cu != null ? cu.autoCompactThreshold : null;
    if (threshold == null && cu != null && Array.isArray(cu.categories)) {
      const buffer = cu.categories.find(function (c) {
        return c.kind === "buffer";
      });
      threshold = buffer != null ? ctx.size - buffer.tokens : null;
    }
    if (threshold == null) {
      return "/compact summarizes the conversation";
    }
    return threshold > ctx.used ? tok(threshold - ctx.used) + " until auto-compact" : "Auto-compact is due";
  }

  // Queued while busy, as any prompt. /compact goes to the CLI like a typed one.
  function compact(model) {
    const entry = { id: util.uid(), text: "/compact", images: [], createdAt: Date.now() };
    const rt = model.runtime;
    const status = rt.status();
    const done = status === "busy" || status === "waiting" ? Promise.resolve(rt.queue.add(entry)) : Promise.resolve(rt.send(entry));
    done.catch(function (e) {
      CC.ui.toast("Compact failed: " + e.message, { level: "error" });
    });
  }

  // --- drill-down ---

  function detailSection(parent, title, sub) {
    const s = el("div", "cc-cxd-section");
    const head = el("div", "cc-cxd-head");
    head.appendChild(el("span", "cc-cxd-title", title));
    if (sub) {
      head.appendChild(el("span", "cc-cxd-sub", sub));
    }
    s.appendChild(head);
    parent.appendChild(s);
    return s;
  }

  function line(parent, name, value, opts) {
    const o = opts || {};
    const r = el(o.onClick != null ? "button" : "div", "cc-cxd-line" + (o.indent ? " is-indent" : ""));
    if (o.onClick != null) {
      r.type = "button";
      r.addEventListener("click", o.onClick);
    }
    const n = el("span", "cc-cxd-name", name);
    n.title = o.title || name;
    r.appendChild(n);
    if (o.tag) {
      r.appendChild(el("span", "cc-cxd-tag", o.tag));
    }
    (o.actions || []).forEach(function (a) {
      r.appendChild(a);
    });
    r.appendChild(el("span", "cc-cxd-value", value));
    parent.appendChild(r);
    return r;
  }

  function memory(parent, cu, model) {
    const files = (cu.memoryFiles || []).slice().sort(byTokens);
    if (files.length === 0) {
      return;
    }
    const s = detailSection(parent, "Memory files", tok(files.reduce(function (a, f) {
      return a + (f.tokens || 0);
    }, 0)));
    files.forEach(function (f) {
      line(s, util.shortPath(f.path, model.cwd()), tok(f.tokens), { title: f.path, tag: f.type, onClick: function () {
        CC.RailData.openPath(f.path);
      } });
    });
  }

  function mcpServers(cu) {
    const servers = {};
    function srv(name) {
      return servers[name] || (servers[name] = { name: name, loaded: 0, deferred: 0, tools: 0, instructions: 0 });
    }
    (cu.mcpTools || []).forEach(function (t) {
      const s = srv(t.serverName || "?");
      s.tools += 1;
      s[t.isLoaded ? "loaded" : "deferred"] += t.tokens || 0;
    });
    (cu.mcpInstructions || []).forEach(function (i) {
      srv(i.serverName || "?").instructions += i.tokens || 0;
    });
    return Object.keys(servers).map(function (k) {
      return servers[k];
    }).sort(function (a, b) {
      return (b.loaded + b.instructions + b.deferred) - (a.loaded + a.instructions + a.deferred);
    });
  }

  function mcp(parent, cu, model) {
    const list = mcpServers(cu);
    if (list.length === 0) {
      return;
    }
    const s = detailSection(parent, "MCP servers", list.length + (list.length === 1 ? " server" : " servers"));
    list.forEach(function (v) {
      const off = CC.ui.chip({
        label: "Disable",
        onClick: function () {
          off.disabled = true;
          CC.RailData.mcpOff(model, v.name).then(function () {
            off.textContent = "Disabled";
          }, function (e) {
            off.disabled = false;
            CC.ui.toast(v.name + ": " + e.message, { level: "error" });
          });
        },
      });
      off.title = "Turn " + v.name + " off, like /mcp";
      const bits = [v.tools + " tools", tok(v.loaded) + " loaded", tok(v.deferred) + " deferred"];
      if (v.instructions > 0) {
        bits.push(tok(v.instructions) + " instructions");
      }
      line(s, v.name, tok(v.loaded + v.instructions), { actions: [off], title: bits.join(" · ") });
      s.appendChild(el("div", "cc-cxd-detail", bits.join(" · ")));
    });
  }

  function skills(parent, cu, model) {
    const sk = cu.skills;
    const sc = cu.slashCommands;
    const agents = cu.agents || [];
    if (sk == null && sc == null && agents.length === 0) {
      return;
    }
    const s = detailSection(parent, "Skills, commands, agents");
    if (sk != null) {
      line(s, "Skills", tok(sk.tokens), { tag: sk.includedSkills != null ? sk.includedSkills + " of " + sk.totalSkills : "" });
      (sk.skillFrontmatter || []).slice().sort(byTokens).slice(0, 8).forEach(function (f) {
        line(s, f.name, tok(f.tokens), { indent: true, title: f.path || f.name, onClick: function () {
          CC.RailData.openSkillFile(model, f.name, sk.skillFrontmatter);
        } });
      });
    }
    if (sc != null) {
      line(s, "Slash commands", tok(sc.tokens), { tag: sc.includedCommands != null ? sc.includedCommands + " of " + sc.totalCommands : "" });
    }
    if (agents.length > 0) {
      line(s, "Agents", tok(agents.reduce(function (a, x) {
        return a + (x.tokens || 0);
      }, 0)), { tag: String(agents.length) });
      agents.slice().sort(byTokens).forEach(function (a) {
        const name = a.agentType || a.name || "agent";
        line(s, name, tok(a.tokens || 0), { indent: true, onClick: function () {
          CC.RailData.openAgentFile(model, name);
        } });
      });
    }
  }

  // mcp__<server>__<tool> rows add up per server.
  function rollUp(rows) {
    const out = {};
    rows.forEach(function (r) {
      const m = /^mcp__(.+?)__/.exec(r.name || "");
      const key = m != null ? "MCP: " + m[1] : r.name;
      const o = out[key] || (out[key] = { name: key, call: 0, result: 0 });
      o.call += r.callTokens || 0;
      o.result += r.resultTokens || 0;
    });
    return Object.keys(out).map(function (k) {
      return out[k];
    }).sort(function (a, b) {
      return (b.call + b.result) - (a.call + a.result);
    });
  }

  function messages(parent, cu) {
    const mb = cu.messageBreakdown;
    if (mb == null) {
      return;
    }
    const s = detailSection(parent, "Messages");
    [["User messages", mb.userMessageTokens], ["Assistant messages", mb.assistantMessageTokens], ["Tool calls", mb.toolCallTokens],
      ["Tool results", mb.toolResultTokens], ["Attachments", mb.attachmentTokens], ["Redirected context", mb.redirectedContextTokens],
      ["Unattributed", mb.unattributedTokens]].forEach(function (p) {
      if (p[1] > 0) {
        line(s, p[0], tok(p[1]));
      }
    });
    const tools = rollUp(mb.toolCallsByType || []);
    if (tools.length > 0) {
      const t = el("table", "cc-cxd-table");
      const head = el("tr");
      ["Tool", "Calls", "Results"].forEach(function (h) {
        head.appendChild(el("th", null, h));
      });
      t.appendChild(head);
      tools.forEach(function (r) {
        const tr = el("tr");
        tr.appendChild(el("td", null, r.name));
        tr.appendChild(el("td", null, tok(r.call)));
        tr.appendChild(el("td", null, tok(r.result)));
        t.appendChild(tr);
      });
      s.appendChild(t);
    }
    const att = (mb.attachmentsByType || []).filter(function (a) {
      return a.tokens > 0;
    }).sort(byTokens).slice(0, 10);
    if (att.length > 0) {
      s.appendChild(el("div", "cc-cxd-group", "Attachments"));
      att.forEach(function (a) {
        line(s, a.name === "hook_success" ? "Hook output" : a.name.replace(/_/g, " "), tok(a.tokens), { indent: true });
      });
    }
  }

  function lastRequest(parent, cu) {
    const u = cu.apiUsage;
    if (u == null) {
      return;
    }
    const read = u.cache_read_input_tokens || 0;
    const write = u.cache_creation_input_tokens || 0;
    const fresh = u.input_tokens || 0;
    const all = read + write + fresh;
    if (all === 0) {
      return;
    }
    const s = detailSection(parent, "Last request", tok(all) + " in · " + tok(u.output_tokens || 0) + " out");
    const bar = el("div", "cc-cx-bar");
    [["Cache read", read, "is-part0"], ["Cache write", write, "is-part1"], ["New input", fresh, "is-part2"]].forEach(function (p) {
      if (p[1] <= 0) {
        return;
      }
      const seg = el("span", "cc-cx-seg " + p[2]);
      seg.style.width = (p[1] / all * 100) + "%";
      bar.appendChild(seg);
    });
    s.appendChild(bar);
    [["Cache read", read, "is-part0"], ["Cache write", write, "is-part1"], ["New input", fresh, "is-part2"]].forEach(function (p) {
      if (p[1] > 0) {
        const row = el("div", "cc-cx-row");
        row.appendChild(el("span", "cc-cx-square " + p[2]));
        row.appendChild(el("span", "cc-cx-name", p[0]));
        row.appendChild(el("span", "cc-cx-tokens", tok(p[1])));
        row.appendChild(el("span", "cc-cx-pct", Math.round(p[1] / all * 100) + "%"));
        s.appendChild(row);
      }
    });
  }

  function fillDetail(box, model) {
    box.replaceChildren();
    if (model.full == null) {
      const waiting = model.fullFailed ? "The breakdown couldn't load. Close and open this to try again." : model.canControl() || model.fullAsked ? "Loading the breakdown…" : "The breakdown needs a running chat.";
      box.appendChild(el("div", "cc-rail-note", waiting));
      return;
    }
    memory(box, model.full, model);
    mcp(box, model.full, model);
    skills(box, model.full, model);
    messages(box, model.full);
    lastRequest(box, model.full);
  }

  // Works only inside `host`; the card and the popover can be up at once.
  function mount(host, ctx) {
    const model = CC.RailData.of(ctx.runtime);
    const release = model.acquire();
    const root = el("div", "cc-cx");
    const top = el("div", "cc-cx-summary");
    const empty = el("div", "cc-rail-note", "No numbers yet. They come with the first reply.");
    let detailBox = null;
    const disclosure = CC.ui.disclosure({
      label: "Full breakdown",
      open: model.fullOpen,
      onToggle: function (open) {
        if (open) {
          model.openFull();
        } else {
          model.closeFull();
        }
      },
      body: function (body) {
        detailBox = el("div", "cc-cxd");
        body.appendChild(detailBox);
      },
    });
    const foot = el("div", "cc-cx-foot");
    const note = el("span", "cc-rail-note");
    const button = CC.ui.button({
      label: "Compact now",
      onClick: function () {
        compact(model);
      },
    });
    foot.appendChild(note);
    foot.appendChild(button);
    root.appendChild(top);
    root.appendChild(empty);
    root.appendChild(foot);
    root.appendChild(disclosure);
    host.appendChild(root);

    let shown = null;
    function paint() {
      const ctxNow = model.context();
      const cu = usageOf(model);
      const counts = model.full || cu || {};
      const signature = JSON.stringify([ctxNow, cu != null ? [cu.categories, cu.autoCompactThreshold, cu.isAutoCompactEnabled] : null, foldedCounts(counts)]);
      if (signature !== shown) {
        shown = signature;
        if (ctxNow != null) {
          summary(top, cu || {}, ctxNow, counts);
          note.textContent = footText(cu, ctxNow);
        }
      }
      empty.hidden = ctxNow != null;
      top.hidden = ctxNow == null;
      foot.hidden = ctxNow == null;
      button.disabled = !model.inChatMode();
      if (disclosure.isOpen() !== model.fullOpen) {
        disclosure.setOpen(model.fullOpen);
      }
      if (detailBox != null && model.fullOpen) {
        if (detailBox.ccFull !== model.full || model.full == null) {
          detailBox.ccFull = model.full;
          fillDetail(detailBox, model);
        }
      }
    }
    const off = model.on(paint);
    if (model.fullOpen) {
      model.openFull();
    }
    paint();

    return {
      unmount: function () {
        off();
        release();
      },
    };
  }

  return { mount: mount, statusOf: statusOf };
})();
