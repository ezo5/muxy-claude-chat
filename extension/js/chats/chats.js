// The page's single list of chats and terminals, over all servers: each server's overview + host terminals + kv `ui/chats` + live runtimes. Starts itself on first
// use, so views simply call it. Unread comes from state changes while a chat isn't in a visible pane.
CC.Chats = (function () {
  const RECENT_RUNTIMES = 8;
  const LIVE_EMIT_MS = 120;

  let started = false;
  // All servers' overview rows; the first server to name a chat keeps it.
  let overview = [];
  const overviews = new Map();
  const overviewServer = new Map();
  const warnedTwice = new Set();
  const hooked = new Map();
  let projects = [];
  let rowsCache = [];
  let byId = new Map();
  let dirty = true;
  let lastJson = "";
  let emitTimer = null;
  let focusedPane = null;
  // Kept in kv: unread rows, titles the daemon couldn't take, fork parents, chats living in a terminal.
  let ui = { unread: [], titles: {}, parents: {}, terminal: {} };
  const terminals = new CC.ChatTerminals.Terminals();
  const runtimes = new Map();
  const recent = [];
  const listeners = new Set();
  // In a pane, so its runtime stays; and read, on screen as a chat, so it collects no unread.
  const shown = new Set();
  const read = new Set();
  const lastState = new Map();
  const lastTurn = new Map();
  const closedNow = new Map();
  const answered = new Map();

  function saveUi() {
    Promise.resolve(CC.Servers.appKv().set("ui", "chats", ui)).catch(function (e) {
      console.warn("chat list state not saved", e && e.message);
    });
  }

  // --- servers ---

  function mergeOverviews() {
    const next = [];
    overviewServer.clear();
    CC.Servers.list().forEach(function (server) {
      (overviews.get(server.key) || []).forEach(function (o) {
        const first = overviewServer.get(o.sessionId);
        if (first != null) {
          if (!warnedTwice.has(o.sessionId)) {
            warnedTwice.add(o.sessionId);
            console.warn("chat " + o.sessionId + " is on two servers, shown on " + first);
          }
          return;
        }
        overviewServer.set(o.sessionId, server.key);
        next.push(o);
      });
    });
    overview = next;
    changed();
  }

  // Each server with chats gets its Hub once; one Muxy no longer lists goes. A server that's away keeps its Hub, which keeps its rows and keeps trying.
  function syncServers() {
    const list = CC.Servers.list();
    list.forEach(function (server) {
      if (hooked.has(server.key) || server.experience !== "chat") {
        return;
      }
      const hub = CC.Hub.of(server);
      const off = hub.overview.on(function (rows) {
        overviews.set(server.key, rows || []);
        mergeOverviews();
      });
      hooked.set(server.key, off);
      overviews.set(server.key, hub.overview.rows() || []);
      hub.start();
    });
    Array.from(hooked.keys()).forEach(function (key) {
      if (CC.Servers.get(key) == null) {
        hooked.get(key)();
        hooked.delete(key);
        overviews.delete(key);
        CC.Hub.drop(key);
      }
    });
    mergeOverviews();
  }

  function storedServer(stored) {
    return (stored.server != null ? CC.Servers.get(stored.server) : null) || CC.Servers.ofCwd(stored.cwd) || CC.Servers.focused();
  }

  // The server a chat is known to be on, null when nothing says.
  function serverOfChat(id) {
    const rt = runtimes.get(id);
    if (rt != null) {
      return rt.server;
    }
    if (overviewServer.has(id)) {
      return CC.Servers.get(overviewServer.get(id));
    }
    return ui.terminal[id] != null ? storedServer(ui.terminal[id]) : null;
  }

  // Two servers can have the same path, so a chat's project is looked for among its server's. Without projects of its own, the one server there is: all of them.
  function projectsOf(server) {
    if (server == null || server.projectIds.length === 0) {
      return projects;
    }
    return projects.filter(function (p) {
      return server.projectIds.indexOf(String(p.id)) >= 0;
    });
  }

  // --- start ---

  function start() {
    if (started) {
      return;
    }
    started = true;
    CC.Servers.on(syncServers);
    syncServers();
    loadUi();
    loadProjects();
    loadTerminals();
    Promise.resolve(CC.host.terminal.agents()).then(function (list) {
      terminals.loadAgents(list);
      changed();
    }).catch(function (e) {
      console.warn("terminal agents not read", e && e.message);
    });
    CC.host.terminal.onChange(function (ev) {
      if (ev != null && ev.paneID != null && ev.kind === "terminal") {
        focusedPane = String(ev.paneID);
      }
      if (terminals.tabEvent(ev)) {
        changed();
      }
      loadTerminals();
    });
    CC.host.terminal.onAgentStatus(function (ev) {
      const res = terminals.agentStatus(ev, Date.now(), focusedPane != null ? "pane:" + focusedPane : null);
      res.unread.forEach(addUnread);
      if (res.changed) {
        changed();
      }
    });
    CC.host.projects.onChange(loadProjects);
  }

  async function loadUi() {
    let saved = null;
    try {
      saved = await CC.Servers.appKv().get("ui", "chats");
    } catch (e) {
      console.warn("chat list state not read", e && e.message);
    }
    if (saved != null) {
      ui = {
        unread: Array.from(new Set((saved.unread || []).concat(ui.unread))),
        titles: Object.assign({}, saved.titles, ui.titles),
        parents: Object.assign({}, saved.parents, ui.parents),
        terminal: Object.assign({}, saved.terminal, ui.terminal),
      };
    }
    // A chat in a terminal has no daemon telling its state, so its mirror runs from the start.
    Object.keys(ui.terminal).forEach(function (id) {
      open(id, { cwd: ui.terminal[id].cwd, server: storedServer(ui.terminal[id]).key });
    });
    changed();
  }

  async function loadProjects() {
    try {
      projects = await CC.host.projects.list();
      changed();
    } catch (e) {
      console.warn("projects not read", e && e.message);
    }
  }

  async function loadTerminals() {
    try {
      if (terminals.setPanes(await CC.host.terminal.list())) {
        changed();
      }
    } catch (e) {
      console.warn("terminals not read", e && e.message);
    }
  }

  // --- rows ---

  function chatRow(id, o, stored) {
    const rt = runtimes.get(id) || null;
    const server = serverOfChat(id);
    const cwd = (rt != null ? rt.store.meta.cwd || rt.cwd : null) || (o != null ? o.cwd : null) || (stored != null ? stored.cwd : null) || null;
    let base = o != null ? CC.ChatRows.fromOverview(o) : { state: "stopped", ask: null, req: null, now: null, tool: null, since: null };
    if (base.req != null && answered.get(id) === base.req) {
      base = { state: "busy", ask: null, req: null, now: null, tool: null, since: null };
    }
    const shows = (rt != null ? CC.ChatRows.fromRuntime(rt, base) : null) || base;
    const meta = rt != null ? rt.store.meta : null;
    const renamed = ui.titles[id];
    const overTitle = renamed != null && (o == null || o.title == null || o.title === renamed.over) ? renamed.title : null;
    const closed = closedNow.has(id) ? closedNow.get(id) : o != null && o.closed === true;
    return {
      id: id, kind: "chat", server: server != null ? server.key : null, title: CC.ChatRows.chatTitle(overTitle, meta, o, cwd), cwd: cwd,
      projectId: CC.ChatTerminals.projectOfPath(cwd, projectsOf(server)), state: shows.state, ask: shows.ask, req: shows.req, now: shows.now, tool: shows.tool, since: shows.since,
      unread: ui.unread.indexOf(id) >= 0, updatedAt: o != null ? o.updatedAt || null : null, preview: o != null ? o.preview || null : null,
      model: (meta != null ? meta.model : null) || (o != null ? o.model || null : null), cost: o != null ? o.cost || 0 : 0, running: o != null ? o.running || [] : [],
      parentId: ui.parents[id] || null, cliSessionId: (meta != null ? meta.cliSessionId : null) || (o != null ? o.cliSessionId || null : null), closed: closed === true,
    };
  }

  function terminalRow(t) {
    const renamed = ui.titles[t.id];
    // Muxy's list of panes says no project, so until an event does, this goes by the path. See SPEC-multi-server.md, known limit.
    const server = CC.Servers.ofCwd(t.cwd, t.projectId);
    return {
      id: t.id, kind: "terminal", server: server != null ? server.key : null, paneId: t.paneId, title: renamed != null ? renamed.title : t.title, cwd: t.cwd, projectId: t.projectId, state: CC.ChatRows.terminalState(t.status),
      ask: null, req: null, now: null, tool: null, since: t.at, unread: ui.unread.indexOf(t.id) >= 0, updatedAt: t.at, preview: null, model: null, cost: 0, running: [],
      parentId: null, cliSessionId: null, closed: false,
    };
  }

  // A pane that is a chat's terminal shows as that chat.
  function chatPanes() {
    const panes = {};
    Object.keys(ui.terminal).forEach(function (id) {
      if (ui.terminal[id].paneId != null) {
        panes[ui.terminal[id].paneId] = true;
      }
    });
    return panes;
  }

  function noteState(row) {
    const prev = lastState.get(row.id);
    const prevTurn = lastTurn.get(row.id);
    const turn = JSON.stringify([row.preview != null ? row.preview.reply : null, row.cost]);
    lastState.set(row.id, row.state);
    lastTurn.set(row.id, turn);
    if (prev == null || read.has(row.id)) {
      return;
    }
    // The overview is looked at once a second, so a short turn of a chat without a runtime can fall between two looks: idle, then idle with a new reply.
    const unseenTurn = prev === "idle" && row.state === "idle" && turn !== prevTurn && !runtimes.has(row.id);
    const changedTo = prev !== row.state && (row.state === "need" || (prev === "busy" && (row.state === "idle" || row.state === "error" || row.state === "bg")));
    if (changedTo || unseenTurn) {
      addUnread(row.id);
    }
  }

  function rebuild() {
    dirty = false;
    const seen = new Set();
    const list = [];
    overview.forEach(function (o) {
      seen.add(o.sessionId);
      list.push(chatRow(o.sessionId, o, null));
      if (answered.has(o.sessionId) && (o.activity == null || o.activity.req !== answered.get(o.sessionId))) {
        answered.delete(o.sessionId);
      }
    });
    // Chats without a daemon: live in a terminal or just created.
    runtimes.forEach(function (rt, id) {
      if (!seen.has(id)) {
        seen.add(id);
        list.push(chatRow(id, null, null));
      }
    });
    Object.keys(ui.terminal).forEach(function (id) {
      if (!seen.has(id)) {
        seen.add(id);
        list.push(chatRow(id, null, ui.terminal[id]));
      }
    });
    list.forEach(noteState);
    const panes = chatPanes();
    terminals.rows(projects).forEach(function (t) {
      if (panes[t.paneId] !== true) {
        const row = terminalRow(t);
        list.push(row);
      }
    });
    // noteState may have added to unread, which the row has to say.
    list.forEach(function (r) {
      r.unread = ui.unread.indexOf(r.id) >= 0;
    });
    byId = new Map(list.map(function (r) {
      return [r.id, r];
    }));
    // A closed chat keeps running, so one that needs an answer must not wait unseen.
    rowsCache = list.filter(function (r) {
      return r.closed !== true || r.state === "need";
    });
  }

  function current() {
    start();
    if (dirty) {
      rebuild();
    }
    return rowsCache;
  }

  function flush() {
    emitTimer = null;
    const list = current();
    const json = JSON.stringify(list);
    if (json === lastJson) {
      return;
    }
    lastJson = json;
    listeners.forEach(function (fn) {
      try {
        fn(list);
      } catch (e) {
        console.error("chat list listener failed", e);
      }
    });
  }

  function changed() {
    dirty = true;
    if (emitTimer == null) {
      emitTimer = setTimeout(flush, 0);
    }
  }

  // A streaming chat changes many times a second, the list needn't.
  function liveChanged() {
    dirty = true;
    if (emitTimer == null) {
      emitTimer = setTimeout(flush, LIVE_EMIT_MS);
    }
  }

  function addUnread(id) {
    if (ui.unread.indexOf(id) < 0) {
      ui.unread.push(id);
      saveUi();
      changed();
    }
  }

  function markRead(id) {
    const at = ui.unread.indexOf(id);
    if (at >= 0) {
      ui.unread.splice(at, 1);
      saveUi();
      changed();
    }
  }

  CC.bus.on("shell:changed", function (e) {
    shown.clear();
    read.clear();
    ((e != null ? e.panes : null) || []).forEach(function (p) {
      if (p.chatId != null) {
        shown.add(p.chatId);
        // A diff of a chat doesn't show its replies, and the sidebar-only state keeps the panes but shows none.
        if (p.kind === "chat" && !(e != null && e.sidebarOnly === true)) {
          read.add(p.chatId);
        }
      }
    });
    read.forEach(markRead);
    evict();
  });

  // --- runtimes ---

  function syncTerminal(id, st) {
    const was = ui.terminal[id];
    if (st.mode === "terminal") {
      const next = { cwd: st.cwd, paneId: st.paneId, server: runtimes.get(id).server.key };
      if (JSON.stringify(was) !== JSON.stringify(next)) {
        ui.terminal[id] = next;
        saveUi();
      }
    } else if (was != null) {
      delete ui.terminal[id];
      saveUi();
    }
    changed();
  }

  function useRecent(id) {
    const at = recent.indexOf(id);
    if (at >= 0) {
      recent.splice(at, 1);
    }
    recent.unshift(id);
  }

  function dropRuntime(id) {
    const rt = runtimes.get(id);
    if (rt != null) {
      runtimes.delete(id);
      rt.dispose();
    }
    const at = recent.indexOf(id);
    if (at >= 0) {
      recent.splice(at, 1);
    }
    changed();
  }

  // Kept: shown, the most recent ones, and those with work only they can do (queued messages, a mirrored terminal).
  function evict() {
    recent.slice(RECENT_RUNTIMES).forEach(function (id) {
      const rt = runtimes.get(id);
      if (rt != null && !shown.has(id) && rt.queue.rows().length === 0 && rt.mode() !== "terminal") {
        dropRuntime(id);
      }
    });
  }

  function makeRuntime(id, opts) {
    const rt = new CC.ChatRuntime(id, opts);
    runtimes.set(id, rt);
    useRecent(id);
    rt.on("state", liveChanged);
    rt.on("items:add", liveChanged);
    rt.on("items:update", liveChanged);
    rt.on("mode", function (st) {
      syncTerminal(id, st);
    });
    evict();
    changed();
    return rt;
  }

  // opts.cwd for a chat the overview doesn't list (found by /resume); a closed chat comes back.
  function open(id, opts) {
    current();
    if (String(id).indexOf("pane:") === 0) {
      return null;
    }
    const known = runtimes.get(id);
    reopen(id);
    if (known != null) {
      useRecent(id);
      evict();
      resumeStopped(known);
      return known;
    }
    const row = overview.find(function (o) {
      return o.sessionId === id;
    });
    const stored = ui.terminal[id];
    const cwd = (opts != null ? opts.cwd : null) || (row != null ? row.cwd : null) || (stored != null ? stored.cwd : null) || null;
    return makeRuntime(id, { cwd: cwd, server: serverFor(id, opts != null ? opts.server : null, cwd) });
  }

  // Who holds the chat says first, then the caller, then its path. opts.server is a key.
  function serverFor(id, key, cwd) {
    return serverOfChat(id) || (key != null ? CC.Servers.get(key) : null) || CC.Servers.ofCwd(cwd) || CC.Servers.focused();
  }

  // Not on the way to the terminal, which stops the daemon on purpose.
  function resumeStopped(rt) {
    if (rt.status() === "stopped" && rt.mode() === "chat" && rt.modeState().switching == null) {
      rt.restart({}).catch(function (e) {
        console.warn("chat " + rt.id + " not resumed:", e && e.message);
      });
    }
  }

  function reopen(id) {
    const row = byId.get(id);
    const wasClosed = closedNow.has(id) ? closedNow.get(id) : row != null && row.closed === true;
    if (wasClosed) {
      closedNow.set(id, false);
      const server = serverOfChat(id) || CC.Servers.focused();
      Promise.resolve(server.host.kv.del("session:" + id, "closed")).catch(function (e) {
        console.warn("chat not reopened", e && e.message);
      });
      changed();
    }
  }

  function parentOfFork(fork) {
    if (fork.parentId != null) {
      return fork.parentId;
    }
    const parent = overview.find(function (o) {
      return o.cliSessionId === fork.cliSessionId;
    });
    return parent != null ? parent.sessionId : null;
  }

  async function create(o) {
    start();
    const opts = o || {};
    const id = CC.util.uuid();
    const server = (opts.server != null ? CC.Servers.get(opts.server) : null) || CC.Servers.ofCwd(opts.cwd) || CC.Servers.focused();
    const hasPrompt = typeof opts.prompt === "string" && opts.prompt.trim() !== "";
    const wantsTerminal = !hasPrompt && opts.fork == null && opts.cliSessionId == null && CC.settings.get("defaultMode") === "terminal";
    const startOpts = { cwd: opts.cwd, model: opts.model, effort: opts.effort, permissionMode: opts.permissionMode, pluginDirs: opts.pluginDirs, addDirs: opts.addDirs,
      appendSystemPromptFile: opts.appendSystemPromptFile };
    if (opts.fork != null) {
      startOpts.cliSessionId = opts.fork.cliSessionId;
      startOpts.resumeAt = opts.fork.resumeAt;
      startOpts.forkSession = true;
      const parent = parentOfFork(opts.fork);
      if (parent != null) {
        ui.parents[id] = parent;
        saveUi();
      }
    } else if (opts.cliSessionId != null) {
      startOpts.cliSessionId = opts.cliSessionId;
      startOpts.resume = opts.resume !== false;
    }
    const rt = makeRuntime(id, wantsTerminal ? { cwd: opts.cwd, server: server, boot: "terminal" } : { cwd: opts.cwd, server: server, start: startOpts });
    try {
      await rt.ready;
    } catch (e) {
      dropRuntime(id);
      if (ui.parents[id] != null) {
        delete ui.parents[id];
        saveUi();
      }
      throw e;
    }
    if (hasPrompt) {
      rt.send({ id: CC.util.uid(), text: opts.prompt, images: [], previews: [], createdAt: Date.now() }).catch(function (e) {
        console.warn("first prompt not sent", e && e.message);
      });
    }
    return id;
  }

  // A running terminal Claude becomes a chat: its own one if the overview knows the conversation, else a new one.
  async function adopt(paneId, tabId, projectId) {
    start();
    const panes = await CC.host.terminal.list();
    const pane = panes.find(function (p) {
      return String(p.id) === String(paneId);
    });
    const cwd = pane != null ? pane.workingDirectory || null : null;
    const server = CC.Servers.ofCwd(cwd, projectId) || CC.Servers.focused();
    const tui = await server.host.call("tuiFind", { cwd: cwd });
    if (tui == null) {
      throw new Error("No running Claude found for " + cwd);
    }
    const row = overview.find(function (o) {
      return o.cliSessionId === tui.sessionId && overviewServer.get(o.sessionId) === server.key;
    });
    const id = row != null ? row.sessionId : CC.util.uuid();
    const rt = runtimes.get(id) || makeRuntime(id, { cwd: tui.cwd || cwd, server: server, boot: "none" });
    await rt.adopt({ paneId: paneId, terminalTabId: tabId });
    return id;
  }

  // Leaves the sidebar; the daemon keeps running until its idle stop, as it does for a closed tab today.
  function close(id) {
    start();
    if (String(id).indexOf("pane:") === 0) {
      return Promise.resolve(CC.host.terminal.close(id.slice("pane:".length)));
    }
    const server = serverOfChat(id) || CC.Servers.focused();
    closedNow.set(id, true);
    if (!shown.has(id)) {
      dropRuntime(id);
    }
    if (ui.terminal[id] != null) {
      delete ui.terminal[id];
      saveUi();
    }
    changed();
    return Promise.resolve(server.host.kv.set("session:" + id, "closed", true));
  }

  // A running daemon takes the title itself, which also renames the conversation. Otherwise it stays in kv until the daemon has a newer one.
  async function rename(id, title) {
    current();
    const name = String(title || "").replace(/\s+/g, " ").trim();
    if (name === "") {
      return;
    }
    const row = byId.get(id);
    const rt = runtimes.get(id);
    const inTerminal = rt != null && rt.mode() === "terminal";
    const stateNow = row != null ? row.state : null;
    if (id.indexOf("pane:") === 0 || inTerminal || stateNow === "stopped" || stateNow === "error") {
      const seen = overview.find(function (o) {
        return o.sessionId === id;
      });
      ui.titles[id] = { title: name, over: seen != null ? seen.title || null : null };
      saveUi();
      if (rt != null) {
        rt.store.setMeta({ title: name });
      }
      changed();
      return;
    }
    if (ui.titles[id] != null) {
      delete ui.titles[id];
      saveUi();
    }
    if (rt != null) {
      rt.store.setMeta({ title: name });
      changed();
      await rt.control("rename_session", { title: name, source: "host" });
      return;
    }
    await (serverOfChat(id) || CC.Servers.focused()).host.call("control", { sessionId: id, subtype: "rename_session", title: name, source: "host" });
  }

  // Works without a runtime: the sidebar answers a chat that isn't open.
  function answer(id, requestId, behavior, extra) {
    start();
    const rt = runtimes.get(id);
    if (rt != null) {
      return rt.respond(requestId, behavior, extra);
    }
    answered.set(id, requestId);
    changed();
    return (serverOfChat(id) || CC.Servers.focused()).host.call("respond", Object.assign({ sessionId: id, requestId: requestId, behavior: behavior }, extra || {})).catch(function (e) {
      answered.delete(id);
      changed();
      throw e;
    });
  }

  return {
    rows: function () {
      return current();
    },
    on: function (fn) {
      start();
      listeners.add(fn);
      return function () {
        listeners.delete(fn);
      };
    },
    get: function (id) {
      current();
      return byId.get(id) || null;
    },
    open: open,
    create: create,
    adopt: adopt,
    close: close,
    rename: rename,
    markRead: markRead,
    answer: answer,
  };
})();
