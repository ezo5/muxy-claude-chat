window.CC = window.CC || {};

// Right sidebar: subagents (with the ones they spawned) and background commands, as rows of the reader op `agents`
// (server/claude_chat/agent_tracker.py: the daemon's rows in chat mode, the transcript in terminal mode). Store items
// that can change a row trigger a poll; a slower timer covers the rest. A click opens a subagent's transcript in its
// own chat tab, or shows the last output lines of a background command.
CC.Agents = (function () {
  const util = CC.util;
  const el = util.el;
  const OPEN_MS = 5000;
  const CLOSED_MS = 30000;
  const CLOSED_RUNNING_MS = 10000;
  const KICK_MS = 300;
  const AGENT_TOOLS = { Agent: true, Task: true, SendMessage: true, TaskStop: true, KillShell: true };

  // Store items after which the rows may differ: agent / background command tools, their results, task notices.
  function touches(store, it) {
    if (it.k === "tool") {
      return AGENT_TOOLS[it.name] === true || (it.name === "Bash" && it.input != null && (it.input.run_in_background === true || it.input.run_in_background === "true"));
    }
    if (it.k === "result") {
      const tool = store.tool(it.tid);
      return tool != null && touches(store, tool);
    }
    return it.k === "notice" && (it.level === "task" || it.level === "handback");
  }

  function Agents(aside, toggleBtn, deps) {
    this.aside = aside;
    this.toggleBtn = toggleBtn;
    this.deps = deps;
    this.store = deps.store;
    this.file = null;
    this.running = 0;
    this.timer = null;
    this.busy = false;
    this.again = false;
    this.due = 0;
    this.forced = false;
    this.status = null;
    this.rows = [];
    this.agentRows = new Map();
    this.badge = el("span", "hdr-badge hidden");
    toggleBtn.appendChild(this.badge);

    const head = el("div", "ag-head");
    head.appendChild(el("span", "ag-title", "Agents"));
    this.count = el("span", "ag-count");
    head.appendChild(this.count);
    this.agentList = el("div", "ag-list");
    this.agentEmpty = el("div", "ag-empty", "No agents yet. Subagents and background commands Claude starts show up here.");
    const scroll = el("div", "ag-scroll");
    scroll.append(head, this.agentEmpty, this.agentList);
    aside.appendChild(scroll);

    const self = this;
    toggleBtn.addEventListener("click", function () {
      self.setOpen(aside.classList.contains("hidden"), true);
    });
    CC.host.storageGet("agents:open:" + CC.host.viewId()).then(function (v) {
      self.setOpen(v === true, false);
    });
    this.store.on("items:add", function (items) {
      if (items.some(function (it) {
        return touches(self.store, it);
      })) {
        self.soon();
      }
    });
    this.store.on("items:update", function (u) {
      if (touches(self.store, u.item)) {
        self.soon();
      }
    });
    this.store.on("reset", function () {
      self.soon();
    });
    this.store.on("state", function () {
      if (self.store.status !== self.status) {
        self.status = self.store.status;
        self.soon();
      }
    });
    setInterval(function () {
      if (self.isOpen()) {
        self.tick();
      }
    }, 1000);
  }

  Agents.prototype.isOpen = function () {
    return !this.aside.classList.contains("hidden");
  };

  Agents.prototype.setOpen = function (open, remember) {
    this.aside.classList.toggle("hidden", !open);
    this.toggleBtn.classList.toggle("active", open);
    if (remember) {
      CC.host.storageSet("agents:open:" + CC.host.viewId(), open);
    }
    this.kick(0);
  };

  Agents.prototype.setFile = function (file) {
    if (file === this.file) {
      return;
    }
    this.file = file || null;
    this.rows = [];
    this.renderAgents(this.rows);
    this.kick(0, true);
  };

  // forced: poll even while the sidebar is closed and nothing runs (the badge and the header count need the rows)
  Agents.prototype.kick = function (delay, forced) {
    const self = this;
    clearTimeout(this.timer);
    this.due = Date.now() + delay;
    this.forced = forced === true;
    this.timer = setTimeout(function () {
      self.poll(forced === true);
    }, delay);
  };

  // Debounced poll after store changes; a burst (streamed tool input) does not keep pushing it back.
  Agents.prototype.soon = function () {
    if (this.busy) {
      this.again = true;
    } else if (!this.forced || this.due - Date.now() > KICK_MS) {
      this.kick(KICK_MS, true);
    }
  };

  Agents.prototype.poll = async function (forced) {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.again = false;
    const open = this.isOpen();
    try {
      if (this.file != null && (open || forced || this.running > 0)) {
        const res = await CC.host.reader("agents", { file: this.file, daemon: this.deps.daemon() });
        this.rows = res.agents || [];
        this.renderAgents(this.rows);
      }
    } catch (e) {
      console.warn("agents poll failed", e && e.message);
    } finally {
      this.busy = false;
      if (this.again) {
        this.kick(KICK_MS, true);
      } else {
        this.kick(open ? OPEN_MS : this.running > 0 ? CLOSED_RUNNING_MS : CLOSED_MS);
      }
    }
  };

  function elapsed(a) {
    if (a.ms != null && a.status !== "running") {
      return a.ms;
    }
    const start = Date.parse(a.startTs);
    const end = a.status === "running" || a.endTs == null ? Date.now() : Date.parse(a.endTs);
    return isNaN(start) ? null : Math.max(0, end - start);
  }

  // Moving a node resets its scroll position, so rows are only moved when out of place.
  function place(list, node, index) {
    if (list.children[index] !== node) {
      list.insertBefore(node, list.children[index] || null);
    }
  }

  function dot(status) {
    return el("span", "ag-dot st-" + status);
  }

  Agents.prototype.tick = function () {
    this.agentRows.forEach(function (r) {
      if (r.data.status === "running") {
        r.time.textContent = util.fmtDuration(elapsed(r.data));
      }
    });
  };

  // Newest first, each item followed by what it spawned ([row, depth] pairs).
  function treeOrder(list) {
    const ids = new Set(list.map(function (a) {
      return a.id;
    }));
    const kids = new Map();
    list.forEach(function (a) {
      const k = ids.has(a.parent) ? a.parent : "";
      if (!kids.has(k)) {
        kids.set(k, []);
      }
      kids.get(k).push(a);
    });
    const out = [];
    function walk(parent, depth) {
      (kids.get(parent) || []).slice().reverse().forEach(function (a) {
        out.push([a, depth]);
        walk(a.id, depth + 1);
      });
    }
    walk("", 0);
    return out;
  }

  Agents.prototype.renderAgents = function (list) {
    const self = this;
    // Background commands (dev servers) can run for hours, so they don't keep the session "busy".
    const running = list.filter(function (a) {
      return a.status === "running" && a.kind !== "bash";
    }).length;
    const changed = running !== this.running;
    this.running = running;
    if (changed) {
      this.deps.onRunning(running);
    }
    this.badge.textContent = String(running);
    this.badge.classList.toggle("hidden", running === 0);
    this.toggleBtn.title = running > 0 ? running + " running agent" + (running === 1 ? "" : "s") : "Agents";
    this.count.textContent = list.length > 0 ? String(list.length) : "";
    this.agentEmpty.classList.toggle("hidden", list.length > 0);
    const ids = new Set();
    treeOrder(list).forEach(function (pair) {
      const a = pair[0];
      ids.add(a.id);
      let r = self.agentRows.get(a.id);
      if (r == null) {
        r = self.agentRow(a);
        self.agentRows.set(a.id, r);
      }
      self.updateAgentRow(r, a, pair[1]);
      place(self.agentList, r.root, ids.size - 1);
    });
    this.agentRows.forEach(function (r, id) {
      if (!ids.has(id)) {
        r.root.remove();
        self.agentRows.delete(id);
      }
    });
  };

  Agents.prototype.agentRow = function (a) {
    const self = this;
    const r = { data: a, root: el("div", "ag-item") };
    const top = el("div", "ag-top");
    r.dot = el("span");
    r.name = el("span", "ag-name");
    r.time = el("span", "ag-time");
    top.append(r.dot, r.name, r.time);
    r.sub = el("div", "ag-sub");
    r.last = el("div", "ag-last");
    r.tail = el("pre", "ag-tail hidden");
    r.root.append(top, r.sub, r.last, r.tail);
    r.root.addEventListener("click", function (e) {
      if (r.data.kind === "bash") {
        if (!r.tail.contains(e.target) || String(window.getSelection() || "") === "") {
          r.root.classList.toggle("expanded");
        }
        return;
      }
      openAgent(r.data, self.deps.cwd(), self.deps.daemon());
    });
    return r;
  };

  Agents.prototype.updateAgentRow = function (r, a, depth) {
    r.data = a;
    const bash = a.kind === "bash";
    r.root.className = "ag-item st-" + a.status + " kind-" + (a.kind || "agent") + (r.root.classList.contains("expanded") ? " expanded" : "") + (depth > 0 ? " nested" : "");
    r.root.style.setProperty("--depth", depth);
    r.root.title = bash ? a.command || "" : a.file != null || a.inline != null ? "Open in a chat tab" : "No transcript for this agent yet";
    r.dot.replaceWith(r.dot = bash ? util.icon("terminal") : dot(a.status));
    r.dot.classList.add("ag-dot", "st-" + a.status);
    r.name.textContent = a.description || a.type;
    r.time.textContent = util.fmtDuration(elapsed(a));
    const states = { running: "running", done: "done", error: "failed", stopped: "stopped" };
    r.sub.textContent = "";
    r.sub.appendChild(el("span", "ag-state", states[a.status] || a.status));
    r.sub.appendChild(document.createTextNode(" · " + (bash ? "background command" : a.type + (a.background ? " · in background" : "")) + (depth > 0 && !bash ? " · nested" : "")));
    r.last.textContent = a.last || "";
    r.last.title = a.last || "";
    r.last.classList.toggle("hidden", !a.last);
    r.tail.textContent = bash ? (a.tail || "(no output yet)") : "";
    r.tail.classList.toggle("hidden", !bash);
  };

  const opening = new Set();

  // tabs.open's singleton is per tab type, so the tab of each agent is remembered by hand.
  async function openAgent(a, cwd, daemon) {
    const file = a.file || a.inline || null;
    if (file == null) {
      util.toast("No transcript for this agent yet");
      return;
    }
    if (opening.has(file)) {
      return;
    }
    opening.add(file);
    const key = "agentTab:" + file;
    try {
      const tabId = await CC.host.storageGet(key);
      if (tabId != null) {
        try {
          await muxy.tabs.switchTo(tabId);
          return;
        } catch (e) {
          await CC.host.storageSet(key, null);
        }
      }
      const parent = (await muxy.tabs.list()).find(function (t) {
        return t.isActive;
      });
      const id = await muxy.tabs.open({
        kind: "extensionWebView",
        extension: { id: "claude-chat", tabType: "chat", data: { agentFile: file, agentTitle: a.description || a.type, daemon: daemon, directory: cwd, cwd: cwd,
          parentTab: parent != null ? parent.id : null, parentTitle: parent != null ? parent.title : null } },
      });
      if (id != null) {
        await CC.host.storageSet(key, id);
      }
    } catch (e) {
      util.toast("Open agent failed: " + e.message, "error");
    } finally {
      opening.delete(file);
    }
  }

  return Agents;
})();
