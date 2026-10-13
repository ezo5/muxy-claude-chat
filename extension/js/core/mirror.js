window.CC = window.CC || {};

// Terminal mode: follows one interactive Claude's transcript with the V1 reader (`poll` pinned by pid / session id,
// `wait` long poll) and feeds the store read-only. `res.session` is the TUI (status, waitingFor, pid) or null.
CC.Mirror = (function () {
  const STATUS = { idle: "idle", busy: "busy", waiting: "waiting" };
  const AGENT_STATUS = { running: "busy", done: "idle", error: "error", stopped: "stopped" };

  function Mirror(store, opts) {
    this.store = store;
    this.cwd = opts.cwd || null;
    this.cliSessionId = opts.cliSessionId || null;
    this.pid = opts.pid || null;
    this.fileHint = opts.file || null;
    this.agentFile = opts.agentFile || null;
    this.daemon = opts.daemon || null;
    this.onTui = opts.onTui || function () {};
    this.file = null;
    this.offset = 0;
    this.start = 0;
    this.watch = null;
    this.tui = null;
    this.running = false;
    this.busy = false;
    this.timer = null;
    this.waiting = null;
    this.waitFailedAt = 0;
  }

  Mirror.prototype.begin = function () {
    this.store.reset();
    this.store.meta = { cwd: this.cwd, cliSessionId: this.cliSessionId };
    this.store.setPending([]);
    this.store.setStatus("connecting");
    this.file = null;
    this.offset = 0;
    this.running = true;
    this.kick(0);
  };

  Mirror.prototype.end = function () {
    this.running = false;
    clearTimeout(this.timer);
    if (this.waiting != null) {
      const job = this.waiting;
      this.waiting = null;
      job.cancel();
    }
  };

  Mirror.prototype.request = function () {
    if (this.agentFile != null) {
      return { agentFile: this.agentFile, daemon: this.daemon, file: this.file, offset: this.file != null ? this.offset : 0 };
    }
    const req = { cwd: this.cwd, pinned: true, file: this.file || this.fileHint, offset: this.file != null ? this.offset : 0 };
    if (this.pid != null) {
      req.pid = this.pid;
    }
    if (this.cliSessionId != null) {
      req.sessionId = this.cliSessionId;
    }
    return req;
  };

  Mirror.prototype.kick = function (delay) {
    const self = this;
    clearTimeout(this.timer);
    if (this.waiting != null) {
      const job = this.waiting;
      this.waiting = null;
      job.cancel();
    }
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(function () {
      self.poll();
    }, delay == null ? 0 : delay);
  };

  Mirror.prototype.schedule = function () {
    if (!this.running) {
      return;
    }
    if (this.watch != null && Date.now() - this.waitFailedAt > 60000) {
      this.wait();
      return;
    }
    this.kick(this.tui != null && this.tui.status !== "idle" ? 900 : 1600);
  };

  Mirror.prototype.wait = async function () {
    const job = CC.host.readerJob("wait", { watch: this.watch, timeoutMs: 25000 });
    this.waiting = job;
    try {
      await job.result;
    } catch (e) {
      if (this.waiting === job) {
        this.waitFailedAt = Date.now();
        console.warn("mirror wait failed, polling instead", e && e.message);
      }
    }
    if (this.waiting === job) {
      this.waiting = null;
      this.kick(0);
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
    this.store.setStatus(tui != null ? STATUS[tui.status] || "idle" : "offline", tui != null ? tui.waitingFor : null);
    this.onTui(tui);
  };

  Mirror.prototype.poll = async function () {
    if (this.busy || !this.running) {
      return;
    }
    this.busy = true;
    let again = false;
    try {
      const res = await CC.host.reader("poll", this.request());
      if (!this.running) {
        return;
      }
      this.watch = res.watch || null;
      this.apply(res);
      again = res.more === true;
    } catch (e) {
      this.watch = null;
      console.error(e && e.message ? e.message : e);
      this.store.setStatus("error", e && e.message ? e.message : String(e));
    } finally {
      this.busy = false;
      if (this.running) {
        if (again) {
          this.kick(0);
        } else {
          this.schedule();
        }
      }
    }
  };

  Mirror.prototype.loadOlder = async function () {
    if (this.file == null || this.start <= 0) {
      return;
    }
    const res = await CC.host.reader("older", { file: this.file, before: this.start });
    this.start = res.start || 0;
    CC.adapters.transcript.prepend(this.store, res.items);
    this.store.setHasOlder(this.start > 0);
  };

  return Mirror;
})();
