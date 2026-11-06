// Terminal panes of this server, rebuilt from the host at load, not persisted. Pure: chats.js feeds it.
CC.ChatTerminals = (function () {
  const AGENT_STATUSES = ["working", "waiting", "idle"];

  // The project a path belongs to: the one with the longest prefix of it, unless a tab or agent event said exactly (`exact`). Null when
  // no project matches.
  function projectOfPath(cwd, projects, exact) {
    if (exact != null) {
      return exact;
    }
    const dir = String(cwd || "");
    let best = null;
    let bestLen = -1;
    (projects || []).forEach(function (p) {
      const path = String(p.path || "").replace(/\/+$/, "");
      if (path === "" || path.length <= bestLen) {
        return;
      }
      if (dir === path || dir.indexOf(path + "/") === 0) {
        best = String(p.id);
        bestLen = path.length;
      }
    });
    return best;
  }

  function Terminals() {
    this.panes = [];        // host list order: {id, title, cwd}
    this.projectOf = {};    // paneId → projectId from tab / pane / agent events
    this.status = {};       // paneId → {status: working | waiting | idle, at: ms of the agent.status event or null}
    this.reported = {};     // worktreeID → the pane reported for it (one agent per worktree, the busiest)
  }

  Terminals.prototype.setPanes = function (list) {
    const next = (list || []).filter(function (p) {
      return p != null && p.id != null;
    }).map(function (p) {
      return { id: String(p.id), title: p.title || "", cwd: p.workingDirectory || "" };
    });
    if (JSON.stringify(next) === JSON.stringify(this.panes)) {
      return false;
    }
    this.panes = next;
    return true;
  };

  // tab.* and pane.* events of terminal tabs carry the exact project, the pane id and the cwd.
  Terminals.prototype.tabEvent = function (ev) {
    if (ev == null || ev.kind !== "terminal" || ev.paneID == null) {
      return false;
    }
    const pane = String(ev.paneID);
    let changed = false;
    if (ev.projectID != null && this.projectOf[pane] !== String(ev.projectID)) {
      this.projectOf[pane] = String(ev.projectID);
      changed = true;
    }
    const known = this.panes.find(function (p) {
      return p.id === pane;
    });
    if (known != null) {
      if (ev.title != null && ev.title !== "" && known.title !== ev.title) {
        known.title = ev.title;
        changed = true;
      }
      if (ev.cwd != null && ev.cwd !== "" && known.cwd !== ev.cwd) {
        known.cwd = ev.cwd;
        changed = true;
      }
    }
    return changed;
  };

  // The agent list at load: statuses without unread transitions.
  Terminals.prototype.loadAgents = function (list) {
    const self = this;
    (list || []).forEach(function (a) {
      self.agentStatus(a, null, null);
    });
  };

  // agent.status {projectID, worktreeID, paneID, status}. Only the busiest agent per worktree is reported, so when the
  // reported pane changes, the previous one is not busier than the new one: a previously working pane is done (idle)
  // unless the new one works too (then its state is unknown). Returns {changed, unread: [row ids]}: a pane whose agent
  // went working → idle | waiting while it was not the active row (`activeId`, "pane:<id>").
  Terminals.prototype.agentStatus = function (ev, now, activeId) {
    const out = { changed: false, unread: [] };
    if (ev == null || ev.paneID == null) {
      return out;
    }
    const self = this;
    const pane = String(ev.paneID);
    const st = AGENT_STATUSES.indexOf(ev.status) >= 0 ? ev.status : "idle";
    function set(id, status) {
      const prev = self.status[id] != null ? self.status[id].status : null;
      if (prev === status) {
        return;
      }
      out.changed = true;
      if (status == null) {
        delete self.status[id];
        return;
      }
      self.status[id] = { status: status, at: now };
      if (now != null && prev === "working" && status !== "working" && "pane:" + id !== activeId) {
        out.unread.push("pane:" + id);
      }
    }
    if (ev.projectID != null && this.projectOf[pane] !== String(ev.projectID)) {
      this.projectOf[pane] = String(ev.projectID);
      out.changed = true;
    }
    if (ev.worktreeID != null) {
      const wt = String(ev.worktreeID);
      const was = this.reported[wt];
      this.reported[wt] = pane;
      if (was != null && was !== pane && this.status[was] != null) {
        const wasStatus = this.status[was].status;
        set(was, st === "working" ? null : wasStatus === "working" ? "idle" : wasStatus);
      }
    }
    set(pane, st);
    return out;
  };

  // {id: "pane:<paneId>", paneId, title, cwd, projectId, status (working | waiting | idle | null), at}
  Terminals.prototype.rows = function (projects) {
    const self = this;
    return this.panes.map(function (p) {
      const s = self.status[p.id];
      return { id: "pane:" + p.id, paneId: p.id, title: p.title, cwd: p.cwd, projectId: projectOfPath(p.cwd, projects, self.projectOf[p.id]),
        status: s != null ? s.status : null, at: s != null ? s.at : null };
    });
  };

  return { Terminals: Terminals, projectOfPath: projectOfPath };
})();
