// Session driver for the agent host (docs/V2-CONTRACT.md): starts and stops the daemon, sends commands to its inbox and feeds its
// events and state through the events adapter. New data arrives from its server's CC.Hub. History before the daemon's
// first start comes from the transcript reader (`older` op) through the transcript adapter.
CC.Agent = (function () {
  const util = CC.util;
  const CHUNK = 350000;
  const CHUNK_AT = 400000;
  const HISTORY_SIZE = 1e12;
  const CONTROL_TIMEOUT_MS = 30000;
  const STOP_WAIT_MS = 60000;

  function Agent(store, opts) {
    this.store = store;
    this.opts = opts || {};
    this.cwd = this.opts.cwd || null;
    this.server = this.opts.server || CC.Servers.focused();
    this.sessionId = null;
    this.file = null;
    this.events = null;
    this.firstStartTs = null;
    this.olderStart = 0;
    this.logStart = 0;
    this.attaching = null;
    this.unsubscribe = null;
    this.attached = Promise.resolve();
    this.attachedDone = function () {};
    this.answered = {};
    this.controls = {};
    this.controlsSending = 0;
    this.controlsEarly = {};
    this.generation = 0;
    this.starting = null;
    const self = this;
    store.on("control", function (e) {
      const c = self.controls[e.id];
      if (c != null) {
        delete self.controls[e.id];
        clearTimeout(c.timer);
        c.resolve(e.response);
      } else if (self.controlsSending > 0) {
        // The long poll can bring the result before the reply to `control` itself.
        self.controlsEarly[e.id] = e.response;
      }
    });
  }

  // --- lifecycle ---

  // Resolves once the daemon runs; `attached` resolves when its events and the history have loaded.
  Agent.prototype.start = function (opts) {
    const self = this;
    const run = this.startDaemon(opts);
    const settled = run.catch(function () {}).then(function () {
      if (self.starting === settled) {
        self.starting = null;
      }
    });
    this.starting = settled;
    return run;
  };

  Agent.prototype.startDaemon = async function (opts) {
    const o = opts || {};
    const gen = ++this.generation;
    this.detach();
    // Before the reset, as a view that sees it asks when everything has arrived. Whoever waited on a start this one replaces has its answer in this one's reset.
    this.attachedDone();
    this.attached = new Promise((resolve) => {
      this.attachedDone = resolve;
    });
    this.store.reset();
    this.store.meta = {};
    this.store.setPending([]);
    this.events = new CC.adapters.events.Events(this.store);
    this.firstStartTs = null;
    this.olderStart = 0;
    this.logStart = 0;
    this.file = this.opts.file || null;
    this.answered = {};
    this.store.resuming = this.store.status === "stopped";
    this.store.setStatus("connecting");
    const req = { cwd: o.cwd || this.cwd, sessionId: o.sessionId || this.sessionId || undefined, resume: o.resume, forkSession: o.forkSession, resumeAt: o.resumeAt,
      model: o.model, effort: o.effort, permissionMode: o.permissionMode, cliSessionId: o.cliSessionId,
      pluginDirs: o.pluginDirs, addDirs: o.addDirs, appendSystemPromptFile: o.appendSystemPromptFile, freshEvents: o.freshEvents };
    let res;
    try {
      res = await this.server.host.call("start", req);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (CC.startErrors.explain(msg) != null) {
        this.store.add([CC.startErrors.notice("start:" + Date.now(), Date.now(), msg)]);
      }
      this.store.setStatus("error", msg);
      this.server.host.probe({ fresh: true }).catch(function (err) {
        console.warn("probe failed", err && err.message);
      });
      this.attachedDone();
      throw e;
    }
    if (gen !== this.generation) {
      return res;
    }
    this.sessionId = res.sessionId;
    this.attach(gen);
    return res;
  };

  // The end of the log, then what's new from there. What's further back loads when asked for, first the rest of the log, then the transcript's
  // history before it: a rewind target may sit in that history. Without an answer the whole log comes through the Hub.
  Agent.prototype.attach = async function (gen) {
    const self = this;
    const run = {};
    this.attaching = run;
    const done = this.attachedDone;
    let tail = null;
    try {
      tail = await this.server.host.call("logTail", { sessionId: this.sessionId });
    } catch (e) {
      console.warn("log tail of " + this.sessionId + " failed", e && e.message);
    }
    if (gen !== this.generation || this.attaching !== run) {
      done();
      return;
    }
    this.attaching = null;
    let after = 0;
    if (tail != null && tail.after != null) {
      after = tail.after;
      this.logStart = tail.start || 0;
      try {
        this.noteFirstStart(tail.carry);
        this.events.adopt(tail.carry);
        this.historyMeta(tail.meta);
        this.apply({ events: tail.events });
      } catch (e) {
        console.error("log tail of " + this.sessionId + " failed", e);
      }
      if (this.logStart > 0) {
        this.store.setHasOlder(true);
      }
    }
    let settled = false;
    this.unsubscribe = CC.Hub.of(this.server).subscribe(this.sessionId, { after: after, stateVersion: 0 }, function (batch) {
      if (gen !== self.generation) {
        return;
      }
      try {
        self.apply(batch);
      } catch (e) {
        console.error("batch of " + self.sessionId + " failed", e);
      }
      if (!settled && batch.more !== true) {
        settled = true;
        if (self.logStart > 0) {
          done();
        } else {
          self.loadHistory(gen).then(done, done);
        }
      }
    });
  };

  Agent.prototype.detach = function () {
    this.attaching = null;
    if (this.unsubscribe != null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  };

  // Stops listening for good, the daemon keeps running.
  Agent.prototype.dispose = function () {
    this.generation += 1;
    this.detach();
  };

  // A stop while the daemon is starting is for that daemon: asked before it runs, the server would find nothing to stop.
  Agent.prototype.stop = async function (force) {
    if (this.starting != null) {
      await this.starting;
    }
    if (this.sessionId == null) {
      return;
    }
    await this.server.host.call("stop", { sessionId: this.sessionId, force: force === true });
  };

  Agent.prototype.restart = async function (opts) {
    const o = opts || {};
    const same = o.sessionId == null || o.sessionId === this.sessionId;
    const prev = this.sessionId;
    if (prev != null && this.store.status !== "stopped") {
      await this.server.host.call("stop", { sessionId: prev });
      if (same) {
        await this.waitStopped();
      }
    }
    return this.start({ sessionId: o.sessionId || prev, resume: o.resume !== false, forkSession: o.forkSession, cwd: o.cwd, model: o.model, effort: o.effort, permissionMode: o.permissionMode,
      addDirs: o.addDirs });
  };

  // The state arrives through the Hub. After the wait the caller goes on regardless, and `start` says if the daemon still runs.
  Agent.prototype.waitStopped = function () {
    const store = this.store;
    return new Promise(function (resolve) {
      if (store.status === "stopped") {
        resolve();
        return;
      }
      let timer = null;
      const off = store.on("state", function () {
        if (store.status === "stopped") {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
      timer = setTimeout(function () {
        off();
        resolve();
      }, Agent.STOP_WAIT_MS);
    });
  };

  // --- commands ---

  Agent.prototype.send = async function (text, images, clientId) {
    const body = { sessionId: this.sessionId, text: text, images: images || [], clientId: clientId };
    const json = JSON.stringify(body);
    if (json.length <= CHUNK_AT) {
      return this.server.host.call("send", body);
    }
    const data = JSON.stringify({ text: text, images: images || [], clientId: clientId });
    const total = Math.ceil(data.length / CHUNK);
    const chunkId = util.uid();
    let res = null;
    for (let i = 0; i < total; i++) {
      res = await this.server.host.call("sendChunk", { sessionId: this.sessionId, chunkId: chunkId, index: i, total: total, data: data.slice(i * CHUNK, (i + 1) * CHUNK) });
    }
    return res;
  };

  Agent.prototype.respond = async function (requestId, behavior, extra) {
    const body = Object.assign({ sessionId: this.sessionId, requestId: requestId, behavior: behavior }, extra || {});
    this.answered[requestId] = true;
    this.store.removePending(function (p) {
      return p.requestId === requestId;
    });
    return this.server.host.call("respond", body);
  };

  Agent.prototype.interrupt = function () {
    return this.server.host.call("interrupt", { sessionId: this.sessionId });
  };

  Agent.prototype.control = async function (subtype, payload) {
    const self = this;
    this.controlsSending += 1;
    let res;
    try {
      res = await this.server.host.call("control", Object.assign({ sessionId: this.sessionId, subtype: subtype }, payload || {}));
    } finally {
      this.controlsSending -= 1;
    }
    const early = Object.prototype.hasOwnProperty.call(this.controlsEarly, res.id);
    const response = this.controlsEarly[res.id];
    if (this.controlsSending === 0) {
      this.controlsEarly = {};
    }
    if (early) {
      return response;
    }
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        delete self.controls[res.id];
        reject(new Error("control " + subtype + " timed out"));
      }, Agent.CONTROL_TIMEOUT_MS);
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
        res = await this.server.host.call("older", { file: this.file, before: before, leaf: this.store.meta.forkAt });
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

  // The rest of the log, page by page. A page can hold nothing to show, and at the log's start the transcript's history follows.
  Agent.prototype.loadLogOlder = async function () {
    const gen = this.generation;
    let found = false;
    while (!found && this.logStart > 0) {
      const res = await this.server.host.call("logOlder", { sessionId: this.sessionId, before: this.logStart });
      if (gen !== this.generation) {
        return;
      }
      this.logStart = res.start || 0;
      const items = this.events.olderPage(res.carry, res.events);
      found = items.length > 0;
      if (found) {
        this.store.prepend(items);
      }
    }
    if (this.logStart > 0) {
      this.store.setHasOlder(true);
    } else {
      await this.loadHistory(gen);
    }
  };

  Agent.prototype.loadOlder = async function () {
    if (this.logStart > 0) {
      return this.loadLogOlder();
    }
    if (this.file == null || this.olderStart <= 0) {
      return;
    }
    const res = await this.server.host.call("older", { file: this.file, before: this.olderStart, leaf: this.store.meta.forkAt });
    this.olderStart = res.start || 0;
    this.historyMeta(res.meta);
    CC.adapters.transcript.prepend(this.store, this.olderItems(res.items));
    this.store.setHasOlder(this.olderStart > 0);
  };

  // --- events ---

  Agent.prototype.noteFirstStart = function (envelopes) {
    const self = this;
    (envelopes || []).forEach(function (env) {
      if (self.firstStartTs == null && env.ev != null && env.ev.type === "daemon" && env.ev.subtype === "started") {
        self.firstStartTs = env.ts;
      }
    });
  };

  Agent.prototype.apply = function (res) {
    const self = this;
    this.noteFirstStart(res.events);
    this.events.feed(res.events || []);
    if (res.state != null) {
      const st = Object.assign({}, res.state);
      if (Array.isArray(st.pending)) {
        st.pending = st.pending.filter(function (p) {
          return self.answered[p.requestId] !== true;
        });
        Object.keys(this.answered).forEach(function (id) {
          if (!res.state.pending.some(function (p) {
            return p.requestId === id;
          })) {
            delete self.answered[id];
          }
        });
      }
      this.events.state(st);
    }
    if (res.topic && res.topic !== this.store.meta.topic) {
      this.store.setMeta({ topic: res.topic });
    }
  };

  Agent.CONTROL_TIMEOUT_MS = CONTROL_TIMEOUT_MS;
  Agent.STOP_WAIT_MS = STOP_WAIT_MS;
  return Agent;
})();
