// Terminal mode: follows one interactive Claude's transcript and feeds the store read-only. Reader `poll` params pinned by pid / session
// id go through CC.Hub. `res.session` is the TUI (status, waitingFor, pid) or null. Also used for a read-only subagent transcript.
CC.Mirror = (function () {
  const STATUS = { idle: "idle", busy: "busy", waiting: "waiting" };
  const AGENT_STATUS = { running: "busy", done: "idle", error: "error", stopped: "stopped" };

  function Mirror(store, opts) {
    this.store = store;
    this.key = opts.key || "mirror:" + CC.util.uid();
    this.server = opts.server || CC.Servers.focused();
    this.cwd = opts.cwd || null;
    this.cliSessionId = opts.cliSessionId || null;
    this.pid = opts.pid || null;
    this.fileHint = opts.file || null;
    this.agentFile = opts.agentFile || null;
    this.daemon = opts.daemon || null;
    this.hooks = opts.hooks || null;
    this.answered = {};
    this.onTui = opts.onTui || function () {};
    this.file = null;
    this.offset = 0;
    this.start = 0;
    this.watch = null;
    this.tui = null;
    this.running = false;
    this.off = null;
    this.caughtUp = Promise.resolve();
    this.reachedEnd = function () {};
  }

  Mirror.prototype.begin = function () {
    this.store.reset();
    this.store.meta = { cwd: this.cwd, cliSessionId: this.cliSessionId };
    this.store.setPending([]);
    this.store.setStatus("connecting");
    this.file = null;
    this.offset = 0;
    this.watch = null;
    this.running = true;
    const self = this;
    this.caughtUp = new Promise(function (resolve) {
      self.reachedEnd = resolve;
    });
    this.follow();
  };

  Mirror.prototype.end = function () {
    this.running = false;
    if (this.off != null) {
      this.off();
      this.off = null;
    }
  };

  Mirror.prototype.request = function () {
    const req = this.agentFile != null
      ? { agentFile: this.agentFile, daemon: this.daemon, file: this.file, offset: this.file != null ? this.offset : 0 }
      : { cwd: this.cwd, pinned: true, file: this.file || this.fileHint, offset: this.file != null ? this.offset : 0 };
    if (this.agentFile == null) {
      if (this.pid != null) {
        req.pid = this.pid;
      }
      if (this.cliSessionId != null) {
        req.sessionId = this.cliSessionId;
      }
      if (this.hooks != null) {
        req.hooks = this.hooks;
      }
    }
    if (this.watch != null) {
      req.watch = this.watch;
    }
    return req;
  };

  // The params change with every reply (file, offset, watch), so each reply subscribes again with the new ones.
  Mirror.prototype.follow = function () {
    const self = this;
    if (this.off != null) {
      this.off();
    }
    this.off = CC.Hub.of(this.server).mirror(this.key, this.request(), function (res) {
      self.onPoll(res);
    });
  };

  Mirror.prototype.onPoll = function (res) {
    if (!this.running) {
      return;
    }
    if (res == null || res.more !== true) {
      this.reachedEnd();
    }
    if (res != null && res.error != null) {
      this.watch = null;
      this.store.setStatus("error", String(res.error));
      this.follow();
      return;
    }
    // More to read: without a watch the server answers at once.
    this.watch = res.more === true ? null : res.watch || null;
    try {
      this.apply(res);
    } catch (e) {
      console.error("mirror " + this.key + " failed", e);
    }
    if (this.running) {
      this.follow();
    }
  };

  Mirror.prototype.apply = function (res) {
    const changed = res.file !== this.file || res.reset === true;
    if (changed) {
      this.store.reset();
      this.file = res.file;
      this.start = res.start || 0;
      this.store.setHasOlder(this.start > 0);
    }
    this.offset = res.offset || 0;
    if (res.items != null && res.items.length > 0) {
      CC.adapters.transcript.append(this.store, res.items);
    }
    const tui = res.session || null;
    if (tui != null) {
      this.pid = tui.pid;
      if (tui.sessionId != null && tui.sessionId !== this.cliSessionId) {
        this.cliSessionId = tui.sessionId;
      }
    }
    this.tui = tui;
    const meta = Object.assign({}, res.meta || {}, { cwd: this.cwd, cliSessionId: this.cliSessionId });
    this.store.setMeta(meta);
    if (this.agentFile != null) {
      this.store.setStatus(AGENT_STATUS[res.agentStatus] || "stopped", null);
      return;
    }
    const hooks = tui != null ? res.hooks || null : null;
    const self = this;
    const pending = hooks != null ? hooks.pending.filter(function (p) {
      return self.answered[p.requestId] !== true;
    }) : [];
    if (pending.length > 0 || this.store.pending.length > 0) {
      this.store.setPending(pending);
    }
    // hooks are exact for prompts, permissions and turn ends; an Esc interrupt only shows in the session file
    if (hooks != null && (hooks.status === "waiting" || hooks.at >= (tui.updatedAt || 0))) {
      this.store.setStatus(hooks.status, hooks.status === "waiting" ? "permission" : null);
    } else {
      this.store.setStatus(tui != null ? STATUS[tui.status] || "idle" : "offline", tui != null ? tui.waitingFor : null);
    }
    this.onTui(tui);
  };

  // Answers a permission prompt of the TUI through its PermissionRequest hook (reader `hookRespond`).
  Mirror.prototype.respond = function (requestId, behavior, extra) {
    this.answered[requestId] = true;
    this.store.removePending(function (p) {
      return p.requestId === requestId;
    });
    return this.server.host.call("hookRespond", Object.assign({ dir: this.hooks, id: requestId, behavior: behavior }, extra || {}));
  };

  Mirror.prototype.loadOlder = async function () {
    if (this.file == null || this.start <= 0) {
      return;
    }
    const res = await this.server.host.call("older", { file: this.file, before: this.start });
    this.start = res.start || 0;
    CC.adapters.transcript.prepend(this.store, res.items);
    this.store.setHasOlder(this.start > 0);
  };

  return Mirror;
})();
