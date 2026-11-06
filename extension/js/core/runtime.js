// One open chat without any DOM: Store, Agent or Mirror, Modes and the queue. Every view of the chat works on this object, so all
// of a chat's state lives here. dispose() stops listening; the daemon keeps running and a new runtime reloads from the server.
CC.ChatRuntime = (function () {
  const KEPT_ORIGINALS = 8;

  // opts: {cwd, server, start: daemon start options for a new chat, boot: "resume" (default) | "terminal" | "none"}
  function ChatRuntime(id, opts) {
    const o = opts || {};
    const self = this;
    this.id = id;
    this.cwd = o.cwd || null;
    // For life: its daemon, transcript and session state are there.
    this.server = o.server || CC.Servers.focused();
    this.store = new CC.Store();
    this.agent = new CC.Agent(this.store, { cwd: this.cwd, server: this.server });
    this.mirror = null;
    this.disposed = false;
    this.sending = [];
    this.previews = {};
    this.originals = new Map();
    this.restarting = null;
    this.modes = new CC.Modes(this.ports());
    this.queue = new CC.ChatQueue({
      sessionId: id,
      server: this.server,
      status: function () {
        return self.store.status;
      },
      canDeliver: function () {
        return self.mode() === "chat" && self.agent.sessionId != null;
      },
      send: function (entry) {
        return self.send(entry);
      },
    });
    this.offs = [
      this.store.on("state", function () {
        self.queue.onStatus(self.store.status);
      }),
      this.store.on("items:add", function (items) {
        self.settleSends(items);
      }),
    ];
    this.ready = this.boot(o);
    this.ready.catch(function (e) {
      console.warn("chat " + id + " didn't start:", e && e.message);
    });
  }

  ChatRuntime.prototype.boot = async function (o) {
    if (o.boot === "none") {
      return;
    }
    let restored = false;
    try {
      restored = await this.modes.restore();
    } catch (e) {
      console.warn("terminal mode not restored", e && e.message);
    }
    if (restored || this.disposed) {
      return;
    }
    if (o.boot === "terminal") {
      await this.modes.toTerminal();
      return;
    }
    if (o.start != null) {
      await this.agent.start(Object.assign({ sessionId: this.id }, o.start));
      return;
    }
    await this.findCwd();
    if (!this.disposed) {
      await this.agent.start({ sessionId: this.id, resume: true });
    }
  };

  // Opening before the overview has arrived (a restored layout) still has to resume in the right folder.
  ChatRuntime.prototype.findCwd = async function () {
    if (this.cwd != null) {
      return;
    }
    const st = await this.server.host.call("state", { sessionId: this.id });
    this.cwd = st != null ? st.cwd || null : null;
    this.agent.cwd = this.cwd;
  };

  ChatRuntime.prototype.ports = function () {
    const self = this;
    const store = this.store;
    const agent = this.agent;
    return {
      storageGet: function () {
        return self.server.host.kv.get("session:" + self.id, "mode");
      },
      storageSet: function (value) {
        return value != null ? self.server.host.kv.set("session:" + self.id, "mode", value) : self.server.host.kv.del("session:" + self.id, "mode");
      },
      autoReturn: function () {
        return CC.settings.get("autoReturn") !== false;
      },
      cwd: function () {
        return store.meta.cwd || self.cwd;
      },
      status: function () {
        return store.status;
      },
      sessionId: function () {
        return agent.sessionId;
      },
      cliSessionId: function () {
        return store.meta.cliSessionId || null;
      },
      // A brand-new chat in terminal mode has one id, whichever process writes the transcript.
      uuid: function () {
        return self.id;
      },
      sleep: CC.util.sleep,
      confirm: function (text, buttons) {
        return CC.host.ui.confirm(text, buttons);
      },
      cli: function (op, payload) {
        return self.server.host.call(op, payload);
      },
      claudeBin: async function () {
        const found = await self.server.host.probe();
        return found != null && found.claude != null && found.claude.path ? found.claude.path : "claude";
      },
      agentStop: async function () {
        if (store.status === "busy" || store.status === "waiting") {
          await agent.interrupt().catch(function () {});
        }
        await agent.stop();
        await agent.waitStopped();
        agent.detach();
      },
      // The chat keeps its id; only the transcript behind it changes.
      agentStart: function (opts) {
        return agent.start(Object.assign({}, opts, { sessionId: self.id }));
      },
      listPanes: function () {
        return CC.host.terminal.list();
      },
      // tabs.open uses the current project, so this goes to the chat's server first.
      openTerminal: function (req) {
        return CC.host.terminal.open(self.server.route != null ? Object.assign({ projectId: self.server.route }, req) : req);
      },
      focusTerminal: function (paneId) {
        return Promise.resolve(CC.host.terminal.focus(paneId));
      },
      closePane: function (paneId) {
        return CC.host.terminal.close(paneId);
      },
      mirrorStart: function (opts) {
        if (self.disposed) {
          return;
        }
        agent.detach();
        if (self.mirror != null) {
          self.mirror.end();
        }
        self.mirror = new CC.Mirror(store, { key: "chat:" + self.id, server: self.server, cwd: opts.cwd, cliSessionId: opts.cliSessionId, pid: opts.pid, hooks: opts.hooks || null, onTui: function (tui) {
          self.modes.onTui(tui);
        } });
        self.mirror.begin();
      },
      mirrorStop: function () {
        if (self.mirror != null) {
          self.mirror.end();
          self.mirror = null;
        }
      },
      onChange: function () {
        store.emit("mode", self.modeState());
      },
    };
  };

  // --- contract ---

  ChatRuntime.prototype.status = function () {
    return this.store.status;
  };

  ChatRuntime.prototype.meta = function () {
    return this.store.meta;
  };

  // Store events plus "mode" {modeState} and "sends" [{id, text, images, previews, error}].
  ChatRuntime.prototype.on = function (name, fn) {
    return this.store.on(name, fn);
  };

  ChatRuntime.prototype.send = async function (entry) {
    await this.ready.catch(function () {});
    if (this.mode() === "terminal") {
      throw new Error("This chat is in terminal mode");
    }
    const row = { id: entry.id, text: entry.text, images: (entry.images || []).length, previews: entry.previews || [], error: null };
    this.previews[entry.id] = row.previews;
    if ((entry.images || []).length > 0) {
      this.originals.set(entry.id, entry.images);
      if (this.originals.size > KEPT_ORIGINALS) {
        this.originals.delete(this.originals.keys().next().value);
      }
    }
    this.sending.push(row);
    this.store.emit("sends", this.sends());
    this.queue.markSent();
    try {
      return await this.agent.send(entry.text, entry.images || [], entry.id);
    } catch (e) {
      if (entry.queued === true) {
        this.dropSend(row);
      } else {
        row.error = e && e.message ? e.message : String(e);
        this.store.emit("sends", this.sends());
      }
      throw e;
    }
  };

  ChatRuntime.prototype.interrupt = function () {
    return this.agent.interrupt();
  };

  ChatRuntime.prototype.respond = function (requestId, behavior, extra) {
    return this.mirror != null ? this.mirror.respond(requestId, behavior, extra) : this.agent.respond(requestId, behavior, extra);
  };

  ChatRuntime.prototype.control = function (subtype, payload) {
    return this.agent.control(subtype, payload);
  };

  // A stop right after opening a stopped chat is for the daemon that opening is bringing back.
  ChatRuntime.prototype.stop = async function (force) {
    if (this.restarting != null) {
      await this.restarting;
    }
    return this.agent.stop(force);
  };

  ChatRuntime.prototype.restart = function (opts) {
    const self = this;
    const run = this.findCwd().then(function () {
      return self.agent.restart(Object.assign({ sessionId: self.id }, opts));
    });
    const settled = run.catch(function () {}).then(function () {
      if (self.restarting === settled) {
        self.restarting = null;
      }
    });
    this.restarting = settled;
    return run;
  };

  // Once what there is to show has arrived, so a view can show it all at once. Also after a failed start, which has its own message in the store.
  ChatRuntime.prototype.loaded = async function () {
    await this.ready.catch(function () {});
    if (this.restarting != null) {
      await this.restarting;
    }
    await (this.mirror != null ? this.mirror.caughtUp : this.agent.attached);
  };

  ChatRuntime.prototype.loadOlder = function () {
    return this.mirror != null ? this.mirror.loadOlder() : this.agent.loadOlder();
  };

  ChatRuntime.prototype.toTerminal = function () {
    return this.modes.toTerminal();
  };

  ChatRuntime.prototype.toChat = function () {
    return this.modes.toChat();
  };

  ChatRuntime.prototype.mode = function () {
    return this.modes.state.mode;
  };

  // --- beyond the contract ---

  ChatRuntime.prototype.modeState = function () {
    return Object.assign({}, this.modes.state, { switching: this.modes.switching });
  };

  ChatRuntime.prototype.adopt = function (data) {
    return this.modes.adopt(data);
  };

  ChatRuntime.prototype.transcriptFile = function () {
    return this.mirror != null ? this.mirror.file : this.agent.currentFile();
  };

  // Prompts on their way: not in the store until the daemon accepts them, or kept with `error` when sending failed.
  ChatRuntime.prototype.sends = function () {
    return this.sending.slice();
  };

  // A failed prompt the view has taken back.
  ChatRuntime.prototype.dismissSend = function (id) {
    const row = this.sending.find(function (r) {
      return r.id === id;
    });
    if (row != null) {
      this.dropSend(row);
    }
  };

  // Images are only a count in the events, so the bubble's thumbnails stay here.
  ChatRuntime.prototype.previewsOf = function (clientId) {
    return this.previews[clientId] || [];
  };

  // The images as sent, for the viewer while the transcript may not have them yet: the CLI writes a prompt when it takes it up.
  ChatRuntime.prototype.originalsOf = function (clientId) {
    return this.originals.get(clientId) || [];
  };

  ChatRuntime.prototype.dropSend = function (row) {
    this.sending = this.sending.filter(function (r) {
      return r !== row;
    });
    this.store.emit("sends", this.sends());
  };

  ChatRuntime.prototype.settleSends = function (items) {
    if (this.sending.length === 0) {
      return;
    }
    const accepted = {};
    items.forEach(function (it) {
      if (it.k === "user" && it.clientId != null) {
        accepted[it.clientId] = true;
      }
    });
    const left = this.sending.filter(function (r) {
      return accepted[r.id] !== true;
    });
    if (left.length !== this.sending.length) {
      this.sending = left;
      this.store.emit("sends", this.sends());
    }
  };

  ChatRuntime.prototype.dispose = function () {
    this.disposed = true;
    this.store.emit("dispose");
    this.offs.forEach(function (off) {
      off();
    });
    this.agent.dispose();
    if (this.mirror != null) {
      this.mirror.end();
    }
    this.queue.dispose();
  };

  return ChatRuntime;
})();
