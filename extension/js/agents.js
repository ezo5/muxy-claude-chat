window.CC = window.CC || {};

// Right sidebar: subagents (with the ones they spawned) and background commands. Rows come from the store (Agent /
// Task / background Bash tools, their results and the system/task_* events); the V1 reader op `agents` (transcript
// scan) fills what the store cannot know: nested agents of a subagent transcript, output tails, inline threads.
// A click opens a subagent's transcript in its own chat tab, or shows the last output lines of a background command.
CC.Agents = (function () {
  const util = CC.util;
  const el = util.el;
  const OPEN_MS = 5000;
  const CLOSED_MS = 30000;
  const CLOSED_RUNNING_MS = 10000;
  const TASK_STATUS = { completed: "done", failed: "error", killed: "stopped", stopped: "stopped", running: "running" };

  function flag(v) {
    return v === true || v === "true";
  }

  function activity(it) {
    if (it.k === "text") {
      return it.text.trim().split("\n")[0].slice(0, 160);
    }
    if (it.k !== "tool") {
      return null;
    }
    const inp = it.input || {};
    const keys = ["description", "file_path", "pattern", "command", "url", "query", "skill", "message"];
    for (const k of keys) {
      let v = inp[k];
      if (typeof v === "string" && v.trim()) {
        v = v.trim().split("\n")[0];
        if (k === "file_path") {
          v = v.split("/").pop();
        }
        return (it.name || "tool") + " · " + v.slice(0, 140);
      }
    }
    return it.name || "tool";
  }

  // Rows from the store: one per Agent / Task tool and per background Bash, status from the result and the task events.
  function fromStore(store, file, live) {
    const rows = [];
    const byId = new Map();
    store.items.forEach(function (it) {
      if (it.k !== "tool") {
        return;
      }
      const input = it.input || {};
      const r = store.resultOf(it.id);
      const ex = r != null ? r.extra || {} : {};
      let a = null;
      if (it.name === "Agent" || it.name === "Task") {
        a = { id: it.id, kind: "agent", description: input.description || "", type: input.subagent_type || "general-purpose", background: flag(input.run_in_background),
          startTs: it.ts, endTs: null, status: "running", agentId: null, parent: it.agent || null, ms: null, last: null, lastTs: null };
        if (r != null) {
          a.agentId = ex.agentId || null;
          if (ex.status === "async_launched") {
            a.background = true;
          } else {
            a.status = r.err ? "error" : "done";
            a.endTs = r.ts || null;
            a.ms = ex.totalDurationMs || null;
          }
        }
        const t = store.tasks.get(it.id);
        if (t != null) {
          a.agentId = a.agentId || t.taskId || null;
          if (t.backgrounded) {
            a.background = true;
          }
          if (a.status === "running" && t.status && t.status !== "running") {
            a.status = TASK_STATUS[t.status] || "done";
            a.endTs = t.endedAt || null;
          }
          if (t.ms) {
            a.ms = t.ms;
          }
          if (t.summary) {
            a.last = t.summary.split("\n")[0].slice(0, 160);
            a.lastTs = t.endedAt || null;
          }
        }
      } else if (it.name === "Bash" && flag(input.run_in_background)) {
        const cmd = String(input.command || "");
        a = { id: it.id, kind: "bash", description: input.description || cmd.trim().split("\n")[0].slice(0, 120), type: "bash", command: cmd.slice(0, 2000),
          background: true, startTs: it.ts, endTs: null, status: "running", parent: it.agent || null, ms: null, last: null, lastTs: null };
        if (r != null && (r.err || !ex.background)) {
          a.status = r.err ? "error" : "done";
          a.endTs = r.ts || null;
        }
        const t = store.tasks.get(it.id);
        if (t != null && a.status === "running" && t.status && t.status !== "running") {
          a.status = TASK_STATUS[t.status] || "done";
          a.endTs = t.endedAt || null;
        }
      }
      if (a != null) {
        rows.push(a);
        byId.set(a.id, a);
      }
    });
    store.items.forEach(function (it) {
      const a = it.agent != null ? byId.get(it.agent) : null;
      if (a == null) {
        return;
      }
      const act = activity(it);
      if (act) {
        a.last = act;
        a.lastTs = it.ts || null;
      }
    });
    const base = file != null ? file.replace(/\.jsonl$/, "") + "/subagents/" : null;
    rows.forEach(function (a) {
      let depth = 0;
      let p = a.parent;
      while (p != null && byId.has(p) && depth < 4) {
        depth += 1;
        p = byId.get(p).parent;
      }
      a.depth = depth;
      if (a.parent != null && !byId.has(a.parent)) {
        a.parent = null;
      }
      if (a.kind === "agent" && a.agentId && base != null) {
        a.file = base + "agent-" + a.agentId + ".jsonl";
      }
      if (a.status === "running" && !live) {
        a.status = "stopped";
        a.endTs = a.lastTs;
      }
    });
    return rows;
  }

  // Reader rows add what the store lacks (nested subagents, bash output tails, inline threads); store rows win.
  function merge(storeRows, readerRows) {
    const byId = new Map();
    storeRows.forEach(function (a) {
      byId.set(a.id, a);
    });
    const out = storeRows.slice();
    (readerRows || []).forEach(function (r) {
      const a = byId.get(r.id);
      if (a == null) {
        out.push(r);
        return;
      }
      ["tail", "inline", "output"].forEach(function (k) {
        if (r[k] != null) {
          a[k] = r[k];
        }
      });
      if (a.file == null && r.file != null) {
        a.file = r.file;
      }
      if (r.last != null && (a.last == null || a.kind === "bash")) {
        a.last = r.last;
        a.lastTs = r.lastTs || a.lastTs;
      }
    });
    return out;
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
    this.readerRows = [];
    this.agentRows = new Map();
    this.frame = 0;
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
    ["items:add", "items:prepend", "items:update", "tasks", "reset", "state"].forEach(function (name) {
      self.store.on(name, function () {
        self.refresh();
      });
    });
    setInterval(function () {
      if (self.isOpen()) {
        self.tick();
      }
    }, 1000);
    this.render();
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
    this.readerRows = [];
    this.kick(0);
  };

  // Store changes come in bursts while streaming; one render per animation frame is enough.
  Agents.prototype.refresh = function () {
    const self = this;
    if (this.frame !== 0) {
      return;
    }
    const paint = function () {
      self.frame = 0;
      self.render();
    };
    this.frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(paint) : setTimeout(paint, 16);
  };

  Agents.prototype.kick = function (delay) {
    const self = this;
    clearTimeout(this.timer);
    this.timer = setTimeout(function () {
      self.poll();
    }, delay);
  };

  Agents.prototype.poll = async function () {
    if (this.busy) {
      return;
    }
    this.busy = true;
    const open = this.isOpen();
    try {
      if (this.file != null && (open || this.running > 0)) {
        const res = await CC.host.reader("agents", { file: this.file });
        this.readerRows = res.agents || [];
        this.render();
      }
    } catch (e) {
      console.warn("agents poll failed", e && e.message);
    } finally {
      this.busy = false;
      this.kick(open ? OPEN_MS : this.running > 0 ? CLOSED_RUNNING_MS : CLOSED_MS);
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

  // Newest first, each item followed by what it spawned.
  function treeOrder(list) {
    const kids = new Map();
    list.forEach(function (a) {
      const k = a.parent || "";
      if (!kids.has(k)) {
        kids.set(k, []);
      }
      kids.get(k).push(a);
    });
    const out = [];
    function walk(parent) {
      (kids.get(parent) || []).slice().reverse().forEach(function (a) {
        out.push(a);
        walk(a.id);
      });
    }
    walk("");
    return out;
  }

  Agents.prototype.render = function () {
    const live = this.store.status !== "stopped" && this.store.status !== "offline";
    this.renderAgents(merge(fromStore(this.store, this.file, live), this.readerRows));
  };

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
    treeOrder(list).forEach(function (a) {
      ids.add(a.id);
      let r = self.agentRows.get(a.id);
      if (r == null) {
        r = self.agentRow(a);
        self.agentRows.set(a.id, r);
      }
      self.updateAgentRow(r, a);
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

  Agents.prototype.updateAgentRow = function (r, a) {
    r.data = a;
    const bash = a.kind === "bash";
    r.root.className = "ag-item st-" + a.status + " kind-" + (a.kind || "agent") + (r.root.classList.contains("expanded") ? " expanded" : "") + (a.depth > 0 ? " nested" : "");
    r.root.style.setProperty("--depth", a.depth || 0);
    r.root.title = bash ? a.command || "" : a.file != null || a.inline != null ? "Open in a chat tab" : "No transcript for this agent yet";
    r.dot.replaceWith(r.dot = bash ? util.icon("terminal") : dot(a.status));
    r.dot.classList.add("ag-dot", "st-" + a.status);
    r.name.textContent = a.description || a.type;
    r.time.textContent = util.fmtDuration(elapsed(a));
    const states = { running: "running", done: "done", error: "failed", stopped: "stopped" };
    r.sub.textContent = "";
    r.sub.appendChild(el("span", "ag-state", states[a.status] || a.status));
    r.sub.appendChild(document.createTextNode(" · " + (bash ? "background command" : a.type + (a.background ? " · in background" : "")) + (a.depth > 0 && !bash ? " · nested" : "")));
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

  Agents.fromStore = fromStore;
  return Agents;
})();
