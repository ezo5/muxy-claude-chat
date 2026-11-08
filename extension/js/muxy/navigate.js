// The global commands. New Chat and Adopt come from scripts, which have no events: they leave an intent in the tab's data.
CC.Navigate = (function () {
  const INTENT_MAX_AGE_MS = 30000;
  const MAX_NUMBERED = 9;
  const recent = [];
  let lastIntent = null;

  function report(prefix, e) {
    console.warn(prefix, e);
    CC.ui.toast(prefix + ": " + (e && e.message ? e.message : e), { level: "error" });
  }

  function focusApp() {
    return Promise.resolve(CC.host.app.focusSelf()).catch(function (e) {
      console.warn("couldn't switch to the app:", e && e.message);
    });
  }

  // The sidebar's rendered order, or the row order until there is one. Ids, or rows with an id.
  function order() {
    const rows = CC.Sidebar != null && CC.Sidebar.order != null ? CC.Sidebar.order() : CC.Chats.rows();
    return (rows || []).map(function (r) {
      return typeof r === "string" ? r : r.id;
    });
  }

  async function go(id) {
    if (String(id).indexOf("pane:") === 0 && !CC.PageTerminals.owns(id.slice("pane:".length))) {
      await CC.host.terminal.focus(id.slice("pane:".length));
      return;
    }
    await focusApp();
    if (String(id).indexOf("pane:") === 0) {
      CC.PageTerminals.show(id.slice("pane:".length));
      return;
    }
    CC.Shell.open({ kind: "chat", chatId: id });
  }

  function shownChat() {
    const pane = CC.Shell.focused();
    return pane != null ? pane.chatId : null;
  }

  async function currentRow(front) {
    if (!front) {
      const panes = await CC.host.terminal.list();
      const focused = panes.find(function (p) {
        return p.isFocused === true;
      });
      if (focused != null && CC.Chats.get("pane:" + focused.id) != null) {
        return "pane:" + focused.id;
      }
    }
    return shownChat();
  }

  async function step(delta, front) {
    const list = order();
    if (list.length === 0) {
      await focusApp();
      return;
    }
    const at = list.indexOf(await currentRow(front));
    const next = at < 0 ? (delta > 0 ? 0 : list.length - 1) : (at + delta + list.length) % list.length;
    await go(list[next]);
  }

  // Up and down the sidebar's chats, from inside the app. Terminals stay out: going to one leaves the app, and there these keys are Muxy's own.
  function stepChats(delta) {
    const list = order().filter(function (id) {
      return String(id).indexOf("pane:") !== 0;
    });
    if (list.length === 0) {
      return;
    }
    const at = list.indexOf(shownChat());
    const next = at < 0 ? (delta > 0 ? 0 : list.length - 1) : (at + delta + list.length) % list.length;
    CC.Chats.markRead(list[next]);
    CC.Shell.open({ kind: "chat", chatId: list[next] });
    if (CC.Sidebar != null && CC.Sidebar.reveal != null) {
      CC.Sidebar.reveal(list[next]);
    }
  }

  async function numbered(n) {
    const id = order()[n - 1];
    if (id != null) {
      await go(id);
    } else {
      await focusApp();
    }
  }

  // From outside the app this returns to it, which is the way back from a terminal tab. Inside it goes to the chat before this one.
  async function last(front) {
    await focusApp();
    const shown = shownChat();
    if (!front && shown != null) {
      return;
    }
    const known = new Set(CC.Chats.rows().map(function (r) {
      return r.id;
    }));
    const earlier = recent.find(function (id) {
      return id !== shown && known.has(id);
    });
    const target = earlier != null ? earlier : order().find(function (id) {
      return id !== shown && String(id).indexOf("pane:") !== 0;
    });
    if (target != null) {
      CC.Shell.open({ kind: "chat", chatId: target });
    }
  }

  // Where Cmd+T opens, as New Chat decides: the project picked in the sidebar, else the shown chat's or terminal's folder, else the first project of the server the app
  // works on. {server, cwd, projectId}.
  async function terminalPlace() {
    const picked = CC.Sidebar != null ? CC.Sidebar.selectedProject() : null;
    if (picked != null && CC.Servers.ofProject(picked.id) != null) {
      return { server: CC.Servers.ofProject(picked.id), cwd: picked.path || null, projectId: picked.id };
    }
    const pane = CC.Shell.focused();
    const row = pane != null && pane.chatId != null ? CC.Chats.get(pane.chatId) : null;
    if (row != null && CC.Servers.get(row.server) != null) {
      return { server: CC.Servers.get(row.server), cwd: row.cwd || null, projectId: row.projectId };
    }
    const shell = pane != null && pane.kind === "terminal" ? CC.PageTerminals.where(pane.params.id) : null;
    if (shell != null && CC.Servers.get(shell.server) != null) {
      return { server: CC.Servers.get(shell.server), cwd: shell.cwd || null, projectId: shell.project };
    }
    const server = CC.Servers.focused();
    const first = server != null ? (await CC.host.projects.list()).find(function (p) {
      return server.projectIds.indexOf(String(p.id)) >= 0;
    }) : null;
    return { server: server, cwd: first != null ? first.path : null, projectId: first != null ? first.id : null };
  }

  async function newTerminal() {
    const where = await terminalPlace();
    const opened = where.server != null && await CC.PageTerminals.open(where.server, { cwd: where.cwd, projectId: where.projectId != null ? where.projectId : where.server.route });
    if (!opened) {
      CC.ui.toast("Terminals there need Python", { level: "error" });
    }
  }

  function command(id, run) {
    CC.host.app.onCommand(id, async function () {
      const front = CC.Presence.inFront();
      try {
        await run(front);
      } catch (e) {
        report("That shortcut didn't work", e);
      }
    });
  }

  async function newChat(intent) {
    const selected = intent.shortcut === true && CC.Sidebar != null ? CC.Sidebar.selectedProject() : null;
    if (selected != null) {
      await CC.Sidebar.newChat(selected);
      return;
    }
    // From inside the app: its project is only where the tab lives, the new chat goes where the app is working.
    const data = CC.host.app.data();
    if (intent.projectId != null && data != null && String(intent.projectId) === String(data.projectId) && CC.Sidebar != null) {
      await CC.Sidebar.newChat(null);
      return;
    }
    let cwd = intent.cwd || null;
    if (cwd == null) {
      const active = (await CC.host.projects.list()).find(function (p) {
        return p.isActive === true;
      });
      cwd = active != null ? active.path : null;
    }
    // The project it came from says the server; a path alone may be on two.
    const server = (intent.projectId != null ? CC.Servers.ofProject(intent.projectId) : null) || CC.Servers.ofCwd(cwd) || CC.Servers.focused();
    if (CC.probeCore.noChats(await server.host.probe().catch(function () { return null; }))) {
      if (await CC.PageTerminals.open(server, { cwd: cwd, projectId: intent.projectId != null ? intent.projectId : server.route })) {
        return;
      }
      const pane = await CC.host.terminal.open({ cwd: cwd, projectId: server.route });
      if (pane.paneId != null) {
        await CC.host.terminal.focus(pane.paneId);
      }
      return;
    }
    const id = await CC.Chats.create({ cwd: cwd, server: server.key });
    CC.Shell.open({ kind: "chat", chatId: id });
  }

  async function adopt(intent) {
    if (CC.Chats.adopt == null) {
      throw new Error("this view has no terminals to adopt");
    }
    // No pane from the script: Muxy can't see inside the page, so it may be the terminal focused here.
    const focused = CC.Shell.focused();
    const paneId = intent.paneId != null ? intent.paneId : focused != null && focused.kind === "terminal" ? focused.params.id : null;
    if (paneId == null) {
      throw new Error("Focus the terminal with Claude first.");
    }
    const id = await CC.Chats.adopt(paneId, intent.tabId != null ? intent.tabId : null, intent.projectId);
    CC.Shell.open({ kind: "chat", chatId: id });
  }

  // From a chat tab left by 2.x, which can only hand the chat over. The overview may not have arrived on a page just started, so the cwd comes along.
  function openChat(intent) {
    CC.Chats.open(intent.chatId, { cwd: intent.cwd });
    CC.Chats.markRead(intent.chatId);
    CC.Shell.open({ kind: "chat", chatId: intent.chatId });
  }

  // The tab's data is saved with the tab, so an intent from before a restart must stay undone.
  function readIntent() {
    const data = CC.host.app.data();
    const intent = data != null ? data.intent : null;
    if (intent == null || intent.id === lastIntent) {
      return;
    }
    lastIntent = intent.id;
    if (!(Date.now() - intent.at < INTENT_MAX_AGE_MS)) {
      return;
    }
    if (intent.kind === "new") {
      newChat(intent).catch(function (e) {
        report("Couldn't start a chat", e);
      });
    } else if (intent.kind === "adopt") {
      adopt(intent).catch(function (e) {
        report("Couldn't bring that terminal in", e);
      });
    } else if (intent.kind === "open") {
      try {
        openChat(intent);
      } catch (e) {
        report("Couldn't open that chat", e);
      }
    }
  }

  function start() {
    CC.bus.on("shell:changed", function () {
      const shown = shownChat();
      if (shown != null && recent[0] !== shown) {
        const at = recent.indexOf(shown);
        if (at >= 0) {
          recent.splice(at, 1);
        }
        recent.unshift(shown);
      }
    });
    const shown = shownChat();
    if (shown != null) {
      recent.unshift(shown);
    }
    command("next-chat", function (front) {
      return step(1, front);
    });
    command("prev-chat", function (front) {
      return step(-1, front);
    });
    command("last-chat", last);
    // Not Muxy commands: Muxy keeps this combination for terminals, and a manifest shortcut it already uses would simply not bind.
    CC.Keys.bind("cmd+t", { scope: "global", run: function () { newTerminal().catch(function (e) { report("The terminal didn't open", e); }); } });
    CC.Keys.bind("mod+shift+arrowup", { scope: "global", run: function () { stepChats(-1); } });
    CC.Keys.bind("mod+shift+arrowdown", { scope: "global", run: function () { stepChats(1); } });
    for (let n = 1; n <= MAX_NUMBERED; n++) {
      command("chat-" + n, function () {
        return numbered(n);
      });
    }
    readIntent();
    CC.host.app.onData(readIntent);
  }

  return { start: start, order: order };
})();
