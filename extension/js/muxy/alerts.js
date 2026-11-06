// What needs a sound, a banner or the tab title. Chats come from the rows of CC.Chats, which announce chat:attention and chat:finished;
// plain terminals from agent.status. A pane that is a chat's terminal isn't a terminal row, so it never sounds twice.
CC.Alerts = (function () {
  const TEXT = { attention: "Needs your attention", finished: "Finished working" };
  const TITLE = "Claude Chat";
  const lastState = new Map();
  const panes = new CC.ChatTerminals.Terminals();
  let started = false;
  let waiting = null;
  let titleCount = 0;

  function kindOf(prev, state) {
    if (prev == null || prev === state) {
      return null;
    }
    if (state === "need") {
      return "attention";
    }
    return (prev === "busy" || prev === "bg") && (state === "idle" || state === "error") ? "finished" : null;
  }

  function showTitle(rows) {
    const count = rows.filter(function (r) {
      return r.state === "need";
    }).length;
    if (count === titleCount) {
      return;
    }
    titleCount = count;
    Promise.resolve(CC.host.app.setTitle(count > 0 ? TITLE + " (" + count + ")" : TITLE)).catch(function (e) {
      console.warn("tab title not set:", e && e.message);
    });
  }

  function watchRows(rows) {
    rows.forEach(function (r) {
      if (r.kind !== "chat") {
        return;
      }
      const kind = kindOf(lastState.get(r.id), r.state);
      lastState.set(r.id, r.state);
      if (kind != null) {
        CC.bus.emit(kind === "attention" ? "chat:attention" : "chat:finished", { id: r.id });
      }
    });
    showTitle(rows);
  }

  // One sound for all alerts of one update, and attention wins, as a chord of two says nothing.
  function queueSound(kind) {
    if (waiting == null) {
      waiting = kind;
      Promise.resolve().then(function () {
        const playing = waiting;
        waiting = null;
        CC.Sounds.play(playing);
      });
    } else if (kind === "attention") {
      waiting = kind;
    }
  }

  function alert(kind, title, focused) {
    const s = CC.Sounds.settings();
    if (s.banner === true && !focused) {
      Promise.resolve(CC.host.ui.notify({ title: title || TITLE, body: TEXT[kind] })).catch(function (e) {
        console.warn("banner not shown:", e && e.message);
      });
    }
    if (!focused || s.focused === true) {
      queueSound(kind);
    }
  }

  function onChat(kind, e) {
    const row = CC.Chats.get(e.id);
    alert(kind, row != null ? row.title : null, CC.Presence.inFront() && CC.Presence.chatShown(e.id));
  }

  async function onPane(kind, paneId) {
    const row = CC.Chats.get("pane:" + paneId);
    if (row == null) {
      return;
    }
    let focused = false;
    try {
      focused = (await CC.host.terminal.list()).some(function (p) {
        return String(p.id) === paneId && p.isFocused === true;
      });
    } catch (e) {
      console.warn("terminals not read:", e && e.message);
    }
    alert(kind, row.title, focused);
  }

  function isClaude(ev) {
    return ev != null && (ev.providerID == null || String(ev.providerID).toLowerCase() === "claude");
  }

  function onAgentStatus(ev) {
    if (!isClaude(ev) || ev.paneID == null) {
      return;
    }
    const pane = String(ev.paneID);
    const statusOf = function (id) {
      return panes.status[id] != null ? panes.status[id].status : null;
    };
    const before = statusOf(pane);
    const res = panes.agentStatus(ev, Date.now(), null);
    res.unread.forEach(function (rowId) {
      const id = rowId.slice("pane:".length);
      if (statusOf(id) === "idle") {
        onPane("finished", id);
      }
    });
    if (statusOf(pane) === "waiting" && before !== "waiting") {
      onPane("attention", pane);
    }
  }

  function start() {
    if (started) {
      return;
    }
    started = true;
    CC.bus.on("chat:attention", function (e) {
      onChat("attention", e);
    });
    CC.bus.on("chat:finished", function (e) {
      onChat("finished", e);
    });
    CC.Chats.on(watchRows);
    watchRows(CC.Chats.rows());
    Promise.resolve(CC.host.terminal.agents()).then(function (list) {
      panes.loadAgents((list || []).filter(isClaude));
    }).catch(function (e) {
      console.warn("terminal agents not read:", e && e.message);
    });
    CC.host.terminal.onAgentStatus(onAgentStatus);
  }

  return { start: start };
})();
