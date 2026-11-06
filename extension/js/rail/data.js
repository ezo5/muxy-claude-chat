// What the rail, the ring and the banner read about one chat. One model per runtime, alive while something shows that chat: the agents
// poll, the git numbers and the statusline fill-in run only then, so there's one poll per visible chat however many views ask.
CC.RailData = (function () {
  const OPEN_MS = 5000;
  const CLOSED_MS = 30000;
  const CLOSED_RUNNING_MS = 10000;
  const KICK_MS = 300;
  const STATS_MS = 15000;
  const STATS_EMPTY_MAX = 2;
  const NOTIFY_MS = 30;
  const AGENT_TOOLS = { Agent: true, Task: true, SendMessage: true, TaskStop: true, KillShell: true };
  const CONTROLLABLE = ["idle", "busy", "waiting"];
  const models = new WeakMap();
  const serverNames = new Map();

  // Store items after which the agent rows may differ: agent and background command tools, their results, task notices.
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

  function statusPayload(stats) {
    return stats != null && stats.status != null ? stats.status.payload : null;
  }

  function contextOf(meta, stats) {
    const cu = meta.contextUsage;
    if (cu != null && cu.maxTokens) {
      return { pct: cu.percentage != null ? cu.percentage : Math.round((cu.totalTokens / cu.maxTokens) * 100), used: cu.totalTokens || 0, size: cu.maxTokens };
    }
    const p = statusPayload(stats);
    const cw = p != null ? p.context_window : null;
    if (cw != null && cw.context_window_size) {
      const cur = cw.current_usage || {};
      const used = (cur.input_tokens || 0) + (cur.cache_read_input_tokens || 0) + (cur.cache_creation_input_tokens || 0);
      return { pct: cw.used_percentage || 0, used: used, size: cw.context_window_size };
    }
    const tokens = meta.contextTokens;
    if (!tokens) {
      return null;
    }
    const size = /opus-5|opus-4-[678]|fable-5|sonnet-5|mythos|\[1m\]/.test(meta.modelId || "") ? 1000000 : 200000;
    return { pct: Math.round((tokens / size) * 100), used: tokens, size: size };
  }

  // 5-hour and weekly: {pct, reset (epoch s)}. The daemon's rate limit events first; the optional statusline only fills what is missing.
  function limitsOf(meta, stats) {
    const windows = meta.rateLimit != null ? meta.rateLimit.unifiedWindows : null;
    if (windows != null && windows.five_hour != null && windows.seven_day != null) {
      return {
        five: { pct: (windows.five_hour.utilization || 0) * 100, reset: windows.five_hour.resetsAt },
        seven: { pct: (windows.seven_day.utilization || 0) * 100, reset: windows.seven_day.resetsAt },
      };
    }
    const p = statusPayload(stats);
    const rl = p != null ? p.rate_limits : null;
    if (rl != null && rl.five_hour != null && rl.seven_day != null) {
      return {
        five: { pct: rl.five_hour.used_percentage, reset: rl.five_hour.resets_at },
        seven: { pct: rl.seven_day.used_percentage, reset: rl.seven_day.resets_at },
      };
    }
    const u = stats != null ? stats.usage : null;
    if (u != null && u.ok && u.five_h != null && u.seven_d != null) {
      return { five: { pct: u.five_h.pct, reset: u.five_h.reset }, seven: { pct: u.seven_d.pct, reset: u.seven_d.reset } };
    }
    return null;
  }

  function Model(runtime) {
    this.runtime = runtime;
    this.viewers = 0;
    this.handlers = new Set();
    this.offs = [];
    this.notifyTimer = null;
    this.rows = [];
    this.rowsLoaded = false;
    this.running = 0;
    this.file = null;
    this.timer = null;
    this.due = 0;
    this.forced = false;
    this.busy = false;
    this.again = false;
    this.cardOpen = null;
    this.status = null;
    this.git = null;
    this.gitBusy = false;
    this.gitAgain = false;
    this.stats = null;
    this.statsTimer = null;
    this.statsEmpty = 0;
    this.askedSummary = false;
    this.full = null;
    this.fullOpen = false;
    this.fullAsked = false;
    this.fullFailed = false;
  }

  // The body of a control's reply: `runtime.control` resolves with the daemon's whole `{subtype, request_id, response}`.
  Model.prototype.control = function (subtype, payload) {
    return CC.Commands.control(this.runtime, subtype, payload);
  };

  Model.prototype.meta = function () {
    return this.runtime.meta() || {};
  };

  Model.prototype.row = function () {
    return CC.Chats != null ? CC.Chats.get(this.runtime.id) || null : null;
  };

  Model.prototype.cwd = function () {
    const row = this.row();
    return this.meta().cwd || this.runtime.cwd || (row != null ? row.cwd : null) || null;
  };

  Model.prototype.inChatMode = function () {
    return typeof this.runtime.mode !== "function" || this.runtime.mode() === "chat";
  };

  Model.prototype.canControl = function () {
    return this.inChatMode() && CONTROLLABLE.indexOf(this.runtime.status()) >= 0;
  };

  Model.prototype.context = function () {
    return contextOf(this.meta(), this.stats);
  };

  Model.prototype.limits = function () {
    return limitsOf(this.meta(), this.stats);
  };

  // Running subagents, not background commands: a dev server can run for hours. The overview's count until the first poll answers.
  Model.prototype.runningCount = function () {
    if (this.rowsLoaded) {
      return this.running;
    }
    const row = this.row();
    return row != null && Array.isArray(row.running) ? row.running.length : 0;
  };

  Model.prototype.on = function (fn) {
    const handlers = this.handlers;
    handlers.add(fn);
    return function () {
      handlers.delete(fn);
    };
  };

  // Coalesced, as a streaming turn changes the store many times a second.
  Model.prototype.notify = function () {
    if (this.notifyTimer != null) {
      return;
    }
    const self = this;
    this.notifyTimer = setTimeout(function () {
      self.notifyTimer = null;
      Array.from(self.handlers).forEach(function (fn) {
        fn();
      });
      CC.Rail.refresh();
    }, NOTIFY_MS);
  };

  // Returns the release; the last release stops every timer.
  Model.prototype.acquire = function () {
    const self = this;
    let held = true;
    this.viewers += 1;
    if (this.viewers === 1) {
      this.begin();
    }
    return function () {
      if (held) {
        held = false;
        self.viewers -= 1;
        if (self.viewers === 0) {
          self.end();
        }
      }
    };
  };

  Model.prototype.begin = function () {
    const self = this;
    const rt = this.runtime;
    this.status = rt.status();
    const store = rt.store;
    function itemsChanged(items) {
      if (typeof store.tool === "function" && items.some(function (it) {
        return touches(store, it);
      })) {
        self.soon();
      }
      self.notify();
    }
    this.offs = [
      rt.on("items:add", itemsChanged),
      rt.on("items:prepend", function () {
        self.notify();
      }),
      rt.on("items:update", function (u) {
        itemsChanged([u.item]);
      }),
      rt.on("reset", function () {
        self.soon();
        self.notify();
      }),
      rt.on("state", function () {
        self.onState();
      }),
      rt.on("mode", function () {
        self.soon();
        self.notify();
      }),
      rt.on("change", function () {
        self.notify();
      }),
    ];
    this.kick(0, true);
    this.refreshGit();
    this.askSummary();
    this.statsEmpty = 0;
    this.fillStats();
    this.statsTimer = setInterval(function () {
      self.fillStats();
    }, STATS_MS);
  };

  Model.prototype.end = function () {
    this.offs.forEach(function (off) {
      off();
    });
    this.offs = [];
    clearTimeout(this.timer);
    clearInterval(this.statsTimer);
    this.timer = null;
    this.statsTimer = null;
  };

  Model.prototype.onState = function () {
    const status = this.runtime.status();
    if (status !== this.status) {
      const turnEnded = this.status === "busy";
      this.status = status;
      this.soon();
      if (turnEnded) {
        this.afterTurn();
      } else {
        this.askSummary();
      }
      if (this.fullOpen && this.full == null) {
        this.openFull();
      }
    }
    this.notify();
  };

  Model.prototype.afterTurn = function () {
    this.askedSummary = false;
    this.askSummary();
    this.refreshGit();
    this.statsEmpty = 0;
    this.fillStats();
  };

  // Keeps meta.contextUsage current: the daemon stores the answer in its state.
  Model.prototype.askSummary = function () {
    if (this.askedSummary || !this.canControl() || this.runtime.status() === "busy") {
      return;
    }
    this.askedSummary = true;
    this.runtime.control("get_context_usage", { detail: "summary" }).catch(function (e) {
      console.warn("get_context_usage failed", e && e.message);
    });
  };

  Model.prototype.openFull = function () {
    this.fullOpen = true;
    this.notify();
    if (this.fullAsked || !this.canControl()) {
      return;
    }
    const self = this;
    this.fullAsked = true;
    this.fullFailed = false;
    this.control("get_context_usage", { detail: "full" }).then(function (r) {
      if (self.fullOpen) {
        self.full = r;
        self.notify();
      }
    }, function (e) {
      console.warn("get_context_usage failed", e && e.message);
      self.fullAsked = false;
      self.fullFailed = true;
      self.notify();
    });
  };

  Model.prototype.closeFull = function () {
    this.fullOpen = false;
    this.fullAsked = false;
    this.fullFailed = false;
    this.full = null;
    this.notify();
  };

  // --- agents ---

  Model.prototype.transcriptFile = function () {
    return typeof this.runtime.transcriptFile === "function" ? this.runtime.transcriptFile() || null : null;
  };

  Model.prototype.daemon = function () {
    return this.inChatMode() ? this.runtime.id : null;
  };

  Model.prototype.isCardOpen = function () {
    return this.cardOpen != null && this.cardOpen();
  };

  // forced: polls even while the card is closed and nothing runs, because the count needs the rows.
  Model.prototype.kick = function (delay, forced) {
    if (this.viewers === 0) {
      return;
    }
    const self = this;
    clearTimeout(this.timer);
    this.due = Date.now() + delay;
    this.forced = forced === true;
    this.timer = setTimeout(function () {
      self.poll(forced === true);
    }, delay);
  };

  // Debounced; a burst of streamed tool input doesn't keep pushing it back.
  Model.prototype.soon = function () {
    if (this.busy) {
      this.again = true;
    } else if (!this.forced || this.due - Date.now() > KICK_MS) {
      this.kick(KICK_MS, true);
    }
  };

  Model.prototype.poll = async function (forced) {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.again = false;
    const open = this.isCardOpen();
    try {
      const file = this.transcriptFile();
      if (file !== this.file) {
        this.file = file;
        this.setRows([], false);
      }
      if (file != null && (open || forced || this.running > 0)) {
        const res = await CC.Servers.of(this.runtime).host.call("agents", { file: file, daemon: this.daemon() });
        this.setRows(res.agents || [], true);
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

  Model.prototype.setRows = function (rows, loaded) {
    const changed = JSON.stringify(rows) !== JSON.stringify(this.rows) || loaded !== this.rowsLoaded;
    this.rows = rows;
    this.rowsLoaded = loaded;
    this.running = rows.filter(function (a) {
      return a.status === "running" && a.kind !== "bash";
    }).length;
    if (changed) {
      this.notify();
    }
  };

  // --- git ---

  function quiet(server, op, payload) {
    return server.host.call(op, payload).catch(function () {
      return null;
    });
  }

  // Branch and the uncommitted numbers; on opening and after each turn.
  Model.prototype.refreshGit = async function () {
    if (this.gitBusy) {
      this.gitAgain = true;
      return;
    }
    const cwd = this.cwd();
    if (cwd == null) {
      return;
    }
    const server = CC.Servers.of(this.runtime);
    this.gitBusy = true;
    this.gitAgain = false;
    const got = (await quiet(server, "gitStatus", { cwd: cwd })) || {};
    this.gitBusy = false;
    const git = { branch: got.gitBranch || null, worktree: got.worktree === true, files: got.files || 0, add: got.add || 0, del: got.del || 0 };
    if (JSON.stringify(git) !== JSON.stringify(this.git)) {
      this.git = git;
      this.notify();
    }
    if (this.gitAgain) {
      this.refreshGit();
    }
  };

  // --- statusline fill-in, optional: terminal mode has no daemon events ---

  // Stops after answers that add nothing, until the next turn or the next time the chat is shown. A failed call isn't an answer.
  Model.prototype.fillStats = async function () {
    if (this.statsEmpty >= STATS_EMPTY_MAX || (this.limits() != null && this.context() != null && this.meta().tokens != null)) {
      return;
    }
    const sid = this.meta().cliSessionId || null;
    if (sid == null) {
      return;
    }
    const known = JSON.stringify([this.context(), this.limits()]);
    const stats = await quiet(CC.Servers.of(this.runtime), "stats", { sessionId: sid });
    if (stats == null) {
      return;
    }
    if (JSON.stringify(stats) !== JSON.stringify(this.stats)) {
      this.stats = stats;
      this.notify();
    }
    this.statsEmpty = JSON.stringify([this.context(), this.limits()]) === known ? this.statsEmpty + 1 : 0;
  };

  function of(runtime) {
    let model = models.get(runtime);
    if (model == null) {
      model = new Model(runtime);
      models.set(runtime, model);
    }
    return model;
  }

  // The name of a chat's server, asked once.
  function server(runtime) {
    const from = CC.Servers.of(runtime);
    if (!serverNames.has(from.key)) {
      serverNames.set(from.key, from.host.call("hello", {}).then(function (r) {
        return r.host || null;
      }, function () {
        serverNames.delete(from.key);
        return null;
      }));
    }
    return serverNames.get(from.key);
  }

  // --- opening things named in a card ---

  function openPath(path) {
    CC.bus.emit("path:open", { path: path, line: null });
  }

  async function openFirst(model, cwd, paths, missing) {
    for (const path of paths) {
      try {
        await CC.Servers.of(model.runtime).host.call("fileText", { cwd: cwd, path: path });
        openPath(path);
        return;
      } catch (e) {
        console.warn("not there: " + path);
      }
    }
    CC.ui.toast(missing, { level: "error" });
  }

  // The wire has no path for agents; skills have one in get_context_usage (full).
  function openAgentFile(model, agentName) {
    const name = agentName.replace(/[^\w.-]/g, "");
    const cwd = model.cwd() || ".";
    return openFirst(model, cwd, [cwd + "/.claude/agents/" + name + ".md", "~/.claude/agents/" + name + ".md"], "No .claude/agents/" + name + ".md (built-in or plugin agent)");
  }

  function openSkillFile(model, skillName, frontmatter) {
    const known = (frontmatter || []).find(function (s) {
      return s.name === skillName && s.path;
    });
    const name = skillName.replace(/[^\w.-]/g, "");
    const cwd = model.cwd() || ".";
    const paths = known != null ? [known.path] : [cwd + "/.claude/skills/" + name + "/SKILL.md", "~/.claude/skills/" + name + "/SKILL.md"];
    return openFirst(model, cwd, paths, "No SKILL.md found for " + skillName + " (built-in or plugin skill)");
  }

  async function mcpOff(model, name) {
    await model.control("mcp_toggle", { serverName: name, enabled: false });
  }

  return {
    of: of, server: server, contextOf: contextOf, limitsOf: limitsOf, openPath: openPath, openAgentFile: openAgentFile, openSkillFile: openSkillFile, mcpOff: mcpOff,
  };
})();
