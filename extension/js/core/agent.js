window.CC = window.CC || {};

// Session driver for the V2 agent host (docs/V2-CONTRACT.md): starts / stops the daemon, sends commands to its
// inbox and feeds its events and state.json into the store through the events adapter. History before the daemon's
// first start comes from the V1 transcript reader (`older` op) through the transcript adapter.
CC.Agent = (function () {
  const util = CC.util;
  const CHUNK = 350000;
  const CHUNK_AT = 400000;
  const HISTORY_SIZE = 1e12;
  const CONTROL_TIMEOUT_MS = 30000;

  function Agent(store, opts) {
    this.store = store;
    this.opts = opts || {};
    this.cwd = this.opts.cwd || null;
    this.sessionId = null;
    this.file = null;
    this.events = null;
    this.stateVersion = 0;
    this.firstStartTs = null;
    this.olderStart = 0;
    this.running = false;
    this.busy = false;
    this.timer = null;
    this.waiting = null;
    this.waitFailedAt = 0;
    this.answered = {};
    this.controls = {};
    this.generation = 0;
    const self = this;
    store.on("control", function (e) {
      const c = self.controls[e.id];
      if (c != null) {
        delete self.controls[e.id];
        clearTimeout(c.timer);
        c.resolve(e.response);
      }
    });
  }

  // --- lifecycle ---

  Agent.prototype.start = async function (opts) {
    const o = opts || {};
    const gen = ++this.generation;
    this.stopLoop();
    this.store.reset();
    this.store.meta = {};
    this.store.setPending([]);
    this.events = new CC.adapters.events.Events(this.store);
    this.firstStartTs = null;
    this.olderStart = 0;
    this.file = this.opts.file || null;
    this.answered = {};
    this.store.setStatus("connecting");
    const req = { cwd: o.cwd || this.cwd, sessionId: o.sessionId || this.sessionId || undefined, resume: o.resume, forkSession: o.forkSession,
      model: o.model, effort: o.effort, permissionMode: o.permissionMode, cliSessionId: o.cliSessionId,
      pluginDirs: o.pluginDirs, addDirs: o.addDirs, appendSystemPromptFile: o.appendSystemPromptFile };
    let res;
    try {
      res = await CC.host.cli("start", req);
    } catch (e) {
      this.store.setStatus("error", e && e.message ? e.message : String(e));
      throw e;
    }
    if (gen !== this.generation) {
      return res;
    }
    this.sessionId = res.sessionId;
    if (this.opts.onSession != null) {
      this.opts.onSession(res.sessionId);
    }
    this.running = true;
    await this.attach(gen);
    return res;
  };

  Agent.prototype.attach = async function (gen) {
    let after = 0;
    try {
      for (let i = 0; i < 200; i++) {
        const res = await CC.host.cli("events", { sessionId: this.sessionId, after: after, limit: 500 });
        if (gen !== this.generation) {
          return;
        }
        this.apply(res);
        after = Math.max(after, res.lastSeq || 0);
        if (res.more !== true) {
          break;
        }
      }
    } catch (e) {
      this.store.setStatus("error", e && e.message ? e.message : String(e));
    }
    await this.loadHistory(gen);
    if (gen === this.generation) {
      this.schedule();
    }
  };

  Agent.prototype.stop = async function (force) {
    if (this.sessionId == null) {
      return;
    }
    await CC.host.cli("stop", { sessionId: this.sessionId, force: force === true });
    this.kick(0);
  };

  Agent.prototype.restart = async function (opts) {
    const o = opts || {};
    const same = o.sessionId == null || o.sessionId === this.sessionId;
    const prev = this.sessionId;
    if (prev != null && this.store.status !== "stopped") {
      await CC.host.cli("stop", { sessionId: prev });
      if (same) {
        await this.waitStopped(prev);
      }
    }
    return this.start({ sessionId: o.sessionId || prev, resume: o.resume !== false, forkSession: o.forkSession, cwd: o.cwd, model: o.model, effort: o.effort, permissionMode: o.permissionMode,
      addDirs: o.addDirs });
  };

  Agent.prototype.waitStopped = async function (sid) {
    for (let i = 0; i < 120; i++) {
      const st = await CC.host.cli("state", { sessionId: sid });
      if (st.status === "stopped") {
        return;
      }
      await util.sleep(500);
    }
  };

  // --- commands ---

  Agent.prototype.send = async function (text, images, clientId) {
    const body = { sessionId: this.sessionId, text: text, images: images || [], clientId: clientId };
    const json = JSON.stringify(body);
    if (json.length <= CHUNK_AT) {
      return CC.host.cli("send", body);
    }
    const data = JSON.stringify({ text: text, images: images || [], clientId: clientId });
    const total = Math.ceil(data.length / CHUNK);
    const chunkId = util.uid();
    let res = null;
    for (let i = 0; i < total; i++) {
      res = await CC.host.cli("sendChunk", { sessionId: this.sessionId, chunkId: chunkId, index: i, total: total, data: data.slice(i * CHUNK, (i + 1) * CHUNK) });
    }
    return res;
  };

  Agent.prototype.respond = async function (requestId, behavior, extra) {
    const body = Object.assign({ sessionId: this.sessionId, requestId: requestId, behavior: behavior }, extra || {});
    this.answered[requestId] = true;
    this.store.removePending(function (p) {
      return p.requestId === requestId;
    });
    return CC.host.cli("respond", body);
  };

  Agent.prototype.interrupt = function () {
    return CC.host.cli("interrupt", { sessionId: this.sessionId });
  };

  Agent.prototype.control = async function (subtype, payload) {
    const self = this;
    const res = await CC.host.cli("control", Object.assign({ sessionId: this.sessionId, subtype: subtype }, payload || {}));
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        delete self.controls[res.id];
        reject(new Error("control " + subtype + " timed out"));
      }, CONTROL_TIMEOUT_MS);
      self.controls[res.id] = { resolve: resolve, timer: timer };
    });
  };

  // --- history (transcript before the daemon's first start) ---

  // Current transcript (state.cliSessionId, changes after /clear); `first` = the one the daemon started with, which
  // holds the history before its first start.
  Agent.prototype.transcriptFile = function (first) {
    if (this.opts.file != null) {
      return this.opts.file;
    }
    const m = this.store.meta;
    const cwd = m.cwd || this.cwd;
    const sid = (first ? m.firstCliSessionId || m.cliSessionId : m.cliSessionId) || this.sessionId;
    if (!cwd || !sid) {
      return null;
    }
    return "~/.claude/projects/" + cwd.replace(/[^A-Za-z0-9]/g, "-") + "/" + sid + ".jsonl";
  };

  Agent.prototype.currentFile = function () {
    return this.transcriptFile(false);
  };

  Agent.prototype.olderItems = function (items) {
    const cut = this.firstStartTs;
    return (items || []).filter(function (it) {
      return cut == null || !it.ts || Date.parse(it.ts) < cut;
    });
  };

  Agent.prototype.historyMeta = function (meta) {
    const patch = {};
    const cur = this.store.meta;
    if (meta == null) {
      return;
    }
    if (cur.title == null && meta.customTitle) {
      patch.title = meta.customTitle;
    }
    if (cur.aiTitle == null && meta.aiTitle) {
      patch.aiTitle = meta.aiTitle;
    }
    if (cur.gitBranch == null && meta.gitBranch) {
      patch.gitBranch = meta.gitBranch;
    }
    if (Object.keys(patch).length > 0) {
      this.store.setMeta(patch);
    }
  };

  Agent.prototype.loadHistory = async function (gen) {
    this.file = this.transcriptFile(true);
    if (this.file == null) {
      return;
    }
    let before = HISTORY_SIZE;
    for (let i = 0; i < 4; i++) {
      let res;
      try {
        res = await CC.host.reader("older", { file: this.file, before: before });
      } catch (e) {
        this.olderStart = 0;
        this.store.setHasOlder(false);
        return;
      }
      if (gen !== this.generation) {
        return;
      }
      this.olderStart = res.start || 0;
      before = this.olderStart;
      this.historyMeta(res.meta);
      const items = this.olderItems(res.items);
      if (items.length > 0) {
        CC.adapters.transcript.prepend(this.store, items);
        break;
      }
      if (this.olderStart <= 0) {
        break;
      }
    }
    this.store.setHasOlder(this.olderStart > 0);
  };

  Agent.prototype.loadOlder = async function () {
    if (this.file == null || this.olderStart <= 0) {
      return;
    }
    const res = await CC.host.reader("older", { file: this.file, before: this.olderStart });
    this.olderStart = res.start || 0;
    this.historyMeta(res.meta);
    CC.adapters.transcript.prepend(this.store, this.olderItems(res.items));
    this.store.setHasOlder(this.olderStart > 0);
  };

  // --- event loop ---

  Agent.prototype.apply = function (res) {
    const self = this;
    (res.events || []).forEach(function (env) {
      if (self.firstStartTs == null && env.ev != null && env.ev.type === "daemon" && env.ev.subtype === "started") {
        self.firstStartTs = env.ts;
      }
    });
    this.events.feed(res.events || []);
    const st = res.state;
    if (st != null) {
      if (Array.isArray(st.pending)) {
        st.pending = st.pending.filter(function (p) {
          return self.answered[p.requestId] !== true;
        });
        Object.keys(this.answered).forEach(function (id) {
          if (!st.pending.some(function (p) {
            return p.requestId === id;
          })) {
            delete self.answered[id];
          }
        });
      }
      this.events.state(st);
      this.stateVersion = Math.max(this.stateVersion, st.version || 0);
    }
    if (res.topicAt != null) {
      this.topicAt = res.topicAt;
      if (res.topic && res.topic !== this.store.meta.topic) {
        this.store.setMeta({ topic: res.topic });
      }
    }
  };

  Agent.prototype.kick = function (delay) {
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

  Agent.prototype.stopLoop = function () {
    this.running = false;
    clearTimeout(this.timer);
    if (this.waiting != null) {
      const job = this.waiting;
      this.waiting = null;
      job.cancel();
    }
  };

  Agent.prototype.schedule = function () {
    if (!this.running) {
      return;
    }
    if (this.store.status === "stopped") {
      this.kick(15000);
      return;
    }
    if (Date.now() - this.waitFailedAt > 60000) {
      this.wait();
      return;
    }
    this.kick(this.store.status === "busy" || this.store.status === "waiting" ? 700 : 1500);
  };

  Agent.prototype.wait = async function () {
    const gen = this.generation;
    const job = CC.host.cliJob("wait", { sessionId: this.sessionId, after: this.events.lastSeq, stateVersion: this.stateVersion, topicAt: this.topicAt || 0, timeoutMs: 25000 });
    this.waiting = job;
    let res = null;
    try {
      res = await job.result;
    } catch (e) {
      if (this.waiting === job) {
        this.waitFailedAt = Date.now();
        console.warn("wait failed, polling instead", e && e.message);
      }
    }
    if (this.waiting !== job || gen !== this.generation) {
      return;
    }
    this.waiting = null;
    if (res != null) {
      this.apply(res);
      if (res.more === true) {
        this.kick(0);
        return;
      }
    }
    this.schedule();
  };

  Agent.prototype.poll = async function () {
    if (this.busy || !this.running) {
      return;
    }
    const gen = this.generation;
    this.busy = true;
    let more = false;
    try {
      const res = await CC.host.cli("events", { sessionId: this.sessionId, after: this.events.lastSeq, limit: 500 });
      if (gen !== this.generation) {
        return;
      }
      this.apply(res);
      more = res.more === true;
    } catch (e) {
      console.error(e && e.message ? e.message : e);
      this.store.setStatus("error", e && e.message ? e.message : String(e));
    } finally {
      this.busy = false;
      if (gen === this.generation) {
        if (more) {
          this.kick(0);
        } else {
          this.schedule();
        }
      }
    }
  };

  return Agent;
})();
