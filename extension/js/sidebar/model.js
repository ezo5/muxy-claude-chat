// What the sidebar shows, from rows, projects and the view. Pure: no DOM, no host. `build` returns a flat list of items, top to bottom.
CC.SidebarModel = (function () {
  const DAY_MS = 24 * 3600 * 1000;
  const STATE_GROUPS = [
    { id: "need", label: "Needs you", states: ["need"] },
    { id: "work", label: "Working", states: ["busy", "bg"] },
    { id: "recent", label: "Recent", states: ["idle", "stopped", "error"] },
  ];
  const OTHER = "project:other";
  // The options live in setting `sidebar`, in the shape 2.x stores, so its import has nothing to translate. `groupBy` is new; 2.x's `group` meant something else.
  // The defaults differ from 2.x on purpose: rows say one thing unless you ask for more.
  const DEFAULTS = { groupBy: "project", sortChats: "manual", sortProjects: "manual", showTerminals: true, maxAgeDays: 0, hideInactive: false, lines: 1, text: "reply", meta: [] };
  const SORTS = ["manual", "name", "activity", "status"];
  const NOT_PLAIN = ["AskUserQuestion", "ExitPlanMode"];
  const TILE_TONES = 6;

  function normalizeView(saved) {
    const v = Object.assign({}, DEFAULTS, saved || {});
    v.groupBy = v.groupBy === "state" ? "state" : "project";
    v.sortChats = SORTS.indexOf(v.sortChats) >= 0 ? v.sortChats : DEFAULTS.sortChats;
    v.sortProjects = SORTS.indexOf(v.sortProjects) >= 0 ? v.sortProjects : DEFAULTS.sortProjects;
    v.showTerminals = v.showTerminals !== false;
    v.hideInactive = v.hideInactive === true;
    const days = Number(v.maxAgeDays);
    v.maxAgeDays = days > 0 ? Math.round(days) : 0;
    const lines = Number(v.lines);
    v.lines = lines >= 0 && lines <= 3 ? Math.round(lines) : DEFAULTS.lines;
    v.text = ["reply", "prompt", "both"].indexOf(v.text) >= 0 ? v.text : DEFAULTS.text;
    v.meta = Array.isArray(v.meta) ? v.meta.filter(function (m) {
      return ["model", "time", "cost"].indexOf(m) >= 0;
    }) : [];
    return v;
  }

  // A saved order puts what it doesn't know first, so new chats go on top. Without one, the items as they are.
  function applyOrder(items, saved) {
    if (!Array.isArray(saved) || saved.length === 0) {
      return items;
    }
    const pos = new Map(saved.map(function (id, i) {
      return [id, i];
    }));
    const fresh = items.filter(function (x) {
      return !pos.has(String(x.id));
    });
    const known = items.filter(function (x) {
      return pos.has(String(x.id));
    }).sort(function (a, b) {
      return pos.get(String(a.id)) - pos.get(String(b.id));
    });
    return fresh.concat(known);
  }

  // Rows the order doesn't know yet go on top and stay where they landed, so activity can't move them. `saved` itself when there are none.
  function lockOrder(rows, saved) {
    const known = new Set(saved);
    const fresh = rows.map(function (r) {
      return String(r.id);
    }).filter(function (id) {
      return !known.has(id);
    });
    return fresh.length === 0 ? saved : fresh.concat(saved);
  }

  // Needs you, working, unread, at rest, stopped.
  function rank(r) {
    if (r.state === "need") {
      return 0;
    }
    if (r.state === "busy" || r.state === "bg") {
      return 1;
    }
    if (r.unread) {
      return 2;
    }
    return r.state === "idle" || r.state === "error" ? 3 : 4;
  }

  function byName(a, b) {
    return String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
  }

  // Array sort is stable, so ties keep the manual order.
  function sortRows(rows, mode, saved) {
    const manual = applyOrder(rows, saved);
    function byActivity(a, b) {
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    }
    if (mode === "name") {
      return manual.slice().sort(function (a, b) {
        return byName(a.title, b.title);
      });
    }
    if (mode === "activity") {
      return manual.slice().sort(byActivity);
    }
    if (mode === "status") {
      return manual.slice().sort(function (a, b) {
        return rank(a) - rank(b) || byActivity(a, b);
      });
    }
    return manual;
  }

  // The local Home is first in the list and a server's Home is named so; Muxy moves neither.
  function isHome(p, i) {
    return i === 0 || p.name === "Home";
  }

  function basename(path) {
    const parts = String(path || "").replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || "";
  }

  // The coloured square of a project: its first letter, and a tone that stays the same for the same name.
  function tileOf(name) {
    const text = String(name || "").trim();
    const letter = /[\p{L}\p{N}]/u.exec(text);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return { letter: letter != null ? letter[0].toUpperCase() : "?", tone: hash % TILE_TONES };
  }

  function mineOf(input) {
    return input.projects.filter(function (p) {
      return input.mineIds == null || input.mineIds.has(String(p.id));
    });
  }

  // Whose project a row is, among this server's: its exact project, else the longest path match. A terminal in another server's project
  // isn't listed here: `hidden`. Without a known catalog (`mineIds` null) nothing is hidden.
  function placeRow(row, mine, mineIds) {
    const own = row.projectId != null ? String(row.projectId) : null;
    const isMine = own != null && mine.some(function (p) {
      return String(p.id) === own;
    });
    if (isMine) {
      return { projectId: own, hidden: false };
    }
    const found = CC.ChatTerminals.projectOfPath(row.cwd, mine);
    return { projectId: found, hidden: found == null && own != null && row.kind === "terminal" && mineIds != null };
  }

  // Running subagents in tree order; one whose parent isn't running is top level.
  function agentRows(running) {
    const list = running || [];
    const ids = new Set(list.map(function (a) {
      return a.id;
    }));
    const out = [];
    function walk(parent, depth) {
      list.forEach(function (a) {
        const top = a.parent == null || !ids.has(a.parent);
        if ((parent == null && top) || (parent != null && a.parent === parent)) {
          out.push({ id: a.id, agentId: a.agentId || null, label: a.description || a.type || "Agent", type: a.type || null, depth: depth });
          walk(a.id, depth + 1);
        }
      });
    }
    walk(null, 0);
    return out;
  }

  function previewText(preview, source) {
    const p = preview || {};
    const prompt = p.prompt || "";
    const reply = p.reply || "";
    if (source === "prompt") {
      return prompt;
    }
    if (source === "both") {
      return prompt && reply ? "› " + prompt + "\n" + reply : prompt ? "› " + prompt : reply;
    }
    return reply || prompt;
  }

  // "user@box:~/src" → "~/src": the prefix of a shell title says nothing here.
  function terminalTitle(title) {
    const m = /^[^@\s]+@[^:\s]+:\s*(.+)$/.exec(title || "");
    return m != null ? m[1] : title || "Terminal";
  }

  // The one thing a row says under its title, if anything. Text lines = None means nothing, whatever the state; the marks still tell it.
  function subLine(row, view, active) {
    if (view.lines === 0) {
      return null;
    }
    if (row.state === "need") {
      return { text: row.ask || "Needs your answer", tone: "need" };
    }
    if (row.state === "busy" || row.state === "bg") {
      return row.now ? { text: row.now } : null;
    }
    if (row.state === "error") {
      return { text: "Stopped with an error" };
    }
    const text = previewText(row.preview, view.text);
    return text ? { text: text, lines: active || row.unread ? view.lines : 1 } : null;
  }

  // Only what the settings ask for, and not while it works: then the now line says more.
  function metaText(row, view, now) {
    if (row.kind !== "chat" || row.state === "busy" || row.state === "bg") {
      return null;
    }
    const parts = [];
    if (view.meta.indexOf("model") >= 0 && row.model) {
      parts.push(CC.util.prettyModel(row.model));
    }
    if (view.meta.indexOf("cost") >= 0 && row.cost > 0) {
      parts.push(CC.util.fmtCost(row.cost));
    }
    if (view.meta.indexOf("time") >= 0 && row.updatedAt != null) {
      parts.push(ago(row.updatedAt, now));
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  // Worth a button only for a plain tool permission. stillPending checks that very request before answering.
  function canAllow(row) {
    return row.kind === "chat" && row.state === "need" && row.req != null && row.tool != null && NOT_PLAIN.indexOf(row.tool) < 0;
  }

  // The same rule as 2.x: only that very request, still first in line, and a tool permission rather than a question or a plan.
  // → what answer() needs as `extra`, or null.
  function stillPending(state, requestId) {
    const p = state != null && Array.isArray(state.pending) ? state.pending[0] : null;
    if (p == null || p.requestId !== requestId) {
      return null;
    }
    const request = p.request || {};
    return NOT_PLAIN.indexOf(request.tool_name) >= 0 ? null : { updatedInput: request.input || {} };
  }

  function visibleRows(rows, input, now) {
    const view = input.view;
    return rows.filter(function (r) {
      if (r.kind === "terminal" && !view.showTerminals && input.chatless !== true) {
        return false;
      }
      const old = view.maxAgeDays > 0 && r.state === "stopped" && r.updatedAt != null && now - r.updatedAt > view.maxAgeDays * DAY_MS;
      // "need" is a state of its own, so a chat that needs you is never "stopped" here.
      const inactive = view.hideInactive && r.state === "stopped";
      return !((old || inactive) && !input.active.has(r.id));
    });
  }

  function isCollapsed(key, collapsed) {
    return collapsed[key] != null ? collapsed[key] === true : key === OTHER || key.indexOf(OTHER + ":") === 0;
  }

  function worstMark(rows) {
    const states = rows.map(function (r) {
      return r.state;
    });
    if (states.indexOf("need") >= 0) {
      return "need";
    }
    if (states.indexOf("busy") >= 0 || states.indexOf("bg") >= 0) {
      return "busy";
    }
    return rows.some(function (r) {
      return r.unread;
    }) ? "unread" : null;
  }

  // One group's rows, each followed by its children: its forks in this group, then its running subagents.
  function addRows(items, group, rows, input, order) {
    const groupKey = group.key;
    const mine = mineOf(input);
    const branches = input.branches || {};
    // Grouped by project the header already says whose chat it is, and the row names a branch only when it differs from the project's, which the header doesn't show.
    function tileOfRow(row) {
      if (group.project != null || row.kind !== "chat") {
        return null;
      }
      const placed = placeRow(row, mine, input.mineIds).projectId;
      const project = placed != null ? mine.find(function (p) { return String(p.id) === placed; }) : null;
      return tileOf(project != null ? project.name || basename(project.path) : basename(row.cwd));
    }
    function branchOfRow(row) {
      const branch = row.kind === "chat" ? branches[row.cwd] || null : null;
      return branch != null && branch !== group.branch ? branch : null;
    }
    const inGroup = new Set(rows.map(function (r) {
      return r.id;
    }));
    function isChild(r) {
      return r.parentId != null && r.parentId !== r.id && inGroup.has(r.parentId);
    }
    const seen = new Set();

    function add(row, depth) {
      if (seen.has(row.id)) {
        return;
      }
      seen.add(row.id);
      const forks = rows.filter(function (r) {
        return isChild(r) && r.parentId === row.id;
      });
      const agents = row.kind === "chat" ? agentRows(row.running) : [];
      const kids = forks.length + agents.length;
      const saved = input.open[row.id];
      const open = saved != null ? saved === true : forks.length > 0;
      const active = input.active.has(row.id);
      order.push(row.id);
      items.push({
        type: "row", key: "r:" + row.id, group: groupKey, row: row, depth: depth, active: active, sub: subLine(row, input.view, active), allow: canAllow(row), tile: tileOfRow(row), branch: branchOfRow(row),
        kids: kids > 0 ? { agents: agents.length, open: open } : null, drag: depth === 0 && input.view.sortChats === "manual", meta: metaText(row, input.view, input.now),
      });
      if (open) {
        forks.forEach(function (f) {
          add(f, depth + 1);
        });
        agents.forEach(function (a) {
          items.push({ type: "agent", key: "a:" + row.id + ":" + a.id, chatId: row.id, agent: a, depth: depth + 1 + a.depth });
        });
      }
    }

    rows.filter(function (r) {
      return !isChild(r);
    }).forEach(function (r) {
      add(r, 0);
    });
  }

  function addGroup(items, order, group, rows, input) {
    const collapsed = isCollapsed(group.key, input.collapsed);
    items.push(Object.assign({ type: "group", count: rows.length, collapsed: collapsed, mark: collapsed ? worstMark(rows) : null }, group));
    if (!collapsed) {
      addRows(items, group, rows, input, order);
    }
  }

  function byState(rows, input, items, order) {
    const mine = mineOf(input);
    const here = rows.filter(function (r) {
      return !placeRow(r, mine, input.mineIds).hidden;
    });
    STATE_GROUPS.forEach(function (g) {
      const inGroup = here.filter(function (r) {
        return g.states.indexOf(r.state) >= 0;
      });
      if (inGroup.length > 0) {
        addGroup(items, order, { key: "state:" + (input.serverKey != null ? input.serverKey + ":" : "") + g.id, label: g.label }, inGroup, input);
      }
    });
  }

  function projectSort(list, mode, rowsOf) {
    function last(p) {
      return rowsOf(p).reduce(function (m, r) {
        return Math.max(m, r.updatedAt || 0);
      }, 0);
    }
    function best(p) {
      return rowsOf(p).reduce(function (m, r) {
        return Math.min(m, rank(r));
      }, 5);
    }
    if (mode === "name") {
      return list.slice().sort(function (a, b) {
        return byName(a.name || "", b.name || "");
      });
    }
    if (mode === "activity") {
      return list.slice().sort(function (a, b) {
        return last(b) - last(a);
      });
    }
    if (mode === "status") {
      return list.slice().sort(function (a, b) {
        return best(a) - best(b) || last(b) - last(a);
      });
    }
    return list;
  }

  function projectOf(p, homes) {
    const id = String(p.id);
    return { id: id, path: p.path || "", home: homes.has(id) };
  }

  function byProject(rows, input, items, order) {
    const homes = new Set();
    input.projects.forEach(function (p, i) {
      if (isHome(p, i)) {
        homes.add(String(p.id));
      }
    });
    const mine = mineOf(input);
    const placed = new Map();
    const other = [];
    rows.forEach(function (r) {
      const where = placeRow(r, mine, input.mineIds);
      if (where.hidden) {
        return;
      }
      if (where.projectId == null) {
        other.push(r);
        return;
      }
      if (!placed.has(where.projectId)) {
        placed.set(where.projectId, []);
      }
      placed.get(where.projectId).push(r);
    });
    function rowsOf(p) {
      return placed.get(String(p.id)) || [];
    }
    function nameKey(p) {
      return String(p.name || "").toLowerCase();
    }
    const names = new Map();
    mine.forEach(function (p) {
      names.set(nameKey(p), (names.get(nameKey(p)) || 0) + 1);
    });
    projectSort(applyOrder(mine, input.projectOrder), input.view.sortProjects, rowsOf).filter(function (p) {
      // Muxy can't remove a server's Home, so without rows it stays out of the way unless it is the current project.
      return p.name !== "Home" || rowsOf(p).length > 0 || p.isActive === true || input.chatless === true;
    }).forEach(function (p) {
      const id = String(p.id);
      const label = p.name || basename(p.path);
      addGroup(items, order, {
        key: "project:" + id, selected: input.selectedProject === "project:" + id, label: label, adds: (input.chatless === true ? "New terminal in " : "New chat in ") + label, tile: tileOf(label), branch: (input.branches || {})[p.path] || null, project: projectOf(p, homes, input),
        tag: names.get(nameKey(p)) > 1 ? basename(p.path) : null, drag: input.view.sortProjects === "manual" && !homes.has(id), dragScope: input.serverKey != null ? "projects:" + input.serverKey : "projects",
      }, rowsOf(p), input);
    });
    if (other.length > 0) {
      addGroup(items, order, { key: input.serverKey != null ? OTHER + ":" + input.serverKey : OTHER, label: "Other" }, other, input);
    }
  }

  function emptyOf(input, shownAny) {
    if (shownAny) {
      return null;
    }
    return input.chatless === true ? "noTerminals" : input.rows.length === 0 ? "none" : "filtered";
  }

  // Each server as a group, its projects and rows under it, as `build` does them for one.
  function buildServers(input) {
    const items = [];
    const order = [];
    let shownAny = false;
    input.servers.forEach(function (s) {
      const part = Object.assign({}, input, { rows: s.rows, mineIds: s.ids, chatless: s.chatless === true, branches: s.branches || {}, serverKey: s.key });
      const rows = visibleRows(sortRows(s.rows, input.view.sortChats, input.rowOrder), part, input.now);
      const placed = rows.filter(function (r) {
        return !placeRow(r, mineOf(part), s.ids).hidden;
      });
      const key = "server:" + s.key;
      const collapsed = isCollapsed(key, input.collapsed);
      items.push({
        type: "server", key: key, collapsed: collapsed, mark: collapsed ? worstMark(placed) : null,
        server: { key: s.key, kind: s.kind, name: s.name, title: s.title, state: s.state, stateTitle: s.stateTitle },
      });
      if (collapsed) {
        return;
      }
      const before = items.length;
      (input.view.groupBy === "project" ? byProject : byState)(rows, part, items, order);
      shownAny = shownAny || items.length > before;
    });
    return { items: items, order: order, empty: emptyOf({ rows: input.rows, chatless: input.servers.every(function (s) { return s.chatless === true; }) }, shownAny) };
  }

  // input: {rows, projects, mineIds: Set | null, view, collapsed, open, rowOrder, projectOrder, active: Set of shown chat ids, now, branches: {cwd: name}, chatless: no chats can start here, terminals are all there is,
  //   servers: null (one flat list, until servers are found) | [{key, kind, name, title, state, stateTitle, rows, ids: Set, chatless, branches}], see CC.SidebarServers.tree}
  // → {items, order: row ids as drawn, collapsed skipped, empty: null | "none" | "filtered"}
  function build(given) {
    const input = Object.assign({}, given, { now: given.now || Date.now() });
    if (input.servers != null) {
      return buildServers(input);
    }
    const rows = visibleRows(sortRows(input.rows, input.view.sortChats, input.rowOrder), input, input.now);
    const items = [];
    const order = [];
    if (input.view.groupBy === "project") {
      byProject(rows, input, items, order);
    } else {
      byState(rows, input, items, order);
    }
    return { items: items, order: order, empty: emptyOf(input, items.length > 0) };
  }

  function ago(ts, now) {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) {
      return "now";
    }
    if (s < 3600) {
      return Math.floor(s / 60) + "m";
    }
    if (s < 86400) {
      return Math.floor(s / 3600) + "h";
    }
    return Math.floor(s / 86400) + "d";
  }

  return {
    DEFAULTS: DEFAULTS, normalizeView: normalizeView, build: build, applyOrder: applyOrder, lockOrder: lockOrder, sortRows: sortRows, isHome: isHome, placeRow: placeRow, agentRows: agentRows, previewText: previewText,
    terminalTitle: terminalTitle, tileOf: tileOf, canAllow: canAllow, stillPending: stillPending, ago: ago,
  };
})();
