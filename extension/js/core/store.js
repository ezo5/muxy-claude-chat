window.CC = window.CC || {};

// Conversation model: the normalized items (user | text | thinking | tool | result | notice | turn), session state
// and the derived data views need. No DOM; node tests load it with util.js.
CC.Store = (function () {
  const STANDALONE_TOOLS = { TodoWrite: true, ExitPlanMode: true, AskUserQuestion: true };
  const CLEAR_RE = /^\/(clear|reset|new)(\s|$)/;

  const EDIT_TOOLS = { Edit: true, MultiEdit: true, Write: true, NotebookEdit: true };

  const STEP_KINDS = [
    { kind: "bash", one: "ran a command", many: "ran # commands" },
    { kind: "read", one: "read a file", many: "read # files" },
    { kind: "search", one: "searched the code", many: "searched the code # times" },
    { kind: "edit", one: "made an edit", many: "made # edits" },
    { kind: "web", one: "checked the web", many: "checked the web # times" },
    { kind: "agent", one: "ran an agent", many: "ran # agents" },
    { kind: "generic", one: "used a tool", many: "used # tools" },
  ];

  const TOOL_KIND = {
    Bash: "bash", BashOutput: "bash", KillShell: "bash", KillBash: "bash", Read: "read", NotebookRead: "read", Grep: "search", Glob: "search", LS: "search", Edit: "edit", MultiEdit: "edit", Write: "edit",
    NotebookEdit: "edit", WebFetch: "web", WebSearch: "web", Agent: "agent", Task: "agent", TodoWrite: "todo",
    ExitPlanMode: "plan", AskUserQuestion: "question", Skill: "generic",
  };

  const RUN_KINDS = { read: "explore", search: "explore", bash: "bash", edit: "edit", web: "web" };

  function stepKind(item) {
    if (item.k === "thinking") {
      return "thinking";
    }
    if (item.k !== "tool") {
      return null;
    }
    return TOOL_KIND[item.name] || "generic";
  }

  function key(item) {
    if (item.k === "result") {
      return "result:" + item.tid;
    }
    return item.id != null ? item.k + ":" + item.id : null;
  }

  function Store() {
    this.handlers = {};
    this.meta = {};
    this.status = "connecting";
    this.statusDetail = null;
    this.pending = [];
    this.hasOlder = false;
    this.reset(true);
  }

  Store.prototype.on = function (name, fn) {
    const list = this.handlers[name] || (this.handlers[name] = []);
    list.push(fn);
    return function () {
      const i = list.indexOf(fn);
      if (i >= 0) {
        list.splice(i, 1);
      }
    };
  };

  Store.prototype.emit = function (name, payload) {
    (this.handlers[name] || []).slice().forEach(function (fn) {
      try {
        fn(payload);
      } catch (e) {
        console.error("store handler failed", name, e && e.message);
      }
    });
  };

  Store.prototype.reset = function (silent) {
    this.items = [];
    this.index = new Map();
    this.results = new Map();
    this.tasks = new Map();
    this.lastSeq = 0;
    if (silent !== true) {
      this.emit("reset");
    }
  };

  Store.prototype.get = function (id) {
    return this.index.get("text:" + id) || this.index.get("user:" + id) || this.index.get("tool:" + id) || this.index.get("thinking:" + id) || this.index.get("notice:" + id) || null;
  };

  Store.prototype.tool = function (id) {
    return this.index.get("tool:" + id) || null;
  };

  Store.prototype.resultOf = function (tid) {
    return this.results.get(tid) || null;
  };

  Store.prototype.register = function (item) {
    const k = key(item);
    if (k != null) {
      this.index.set(k, item);
    }
    if (item.k === "result") {
      this.results.set(item.tid, item);
    }
  };

  // Keeps items not seen yet; an id already present with other content gets the next block index of its message.
  Store.prototype.fresh = function (items) {
    const out = [];
    for (const item of items) {
      const k = key(item);
      if (k == null) {
        out.push(item);
        continue;
      }
      const seen = this.index.get(k);
      if (seen == null) {
        this.register(item);
        out.push(item);
        continue;
      }
      if (item.k === "result" || seen.text === item.text) {
        continue;
      }
      const m = /^(.*):(\d+)$/.exec(String(item.id));
      if (m == null) {
        continue;
      }
      let n = Number(m[2]) + 1;
      while (this.index.has(item.k + ":" + m[1] + ":" + n)) {
        n += 1;
      }
      item.id = m[1] + ":" + n;
      this.register(item);
      out.push(item);
    }
    return out;
  };

  Store.prototype.add = function (items) {
    const added = this.fresh(items);
    if (added.length > 0) {
      this.items = this.items.concat(added);
      this.emit("items:add", added);
    }
    return added;
  };

  Store.prototype.prepend = function (items) {
    const added = this.fresh(items);
    if (added.length > 0) {
      this.items = added.concat(this.items);
      this.emit("items:prepend", added);
    }
    return added;
  };

  // Keeps the items before `index` (a rewound conversation) and re-renders them.
  Store.prototype.truncate = function (index) {
    const kept = this.items.slice(0, Math.max(0, index));
    this.index = new Map();
    this.results = new Map();
    kept.forEach(this.register, this);
    this.items = kept;
    this.emit("reset");
    if (kept.length > 0) {
      this.emit("items:add", kept);
    }
    this.emit("state", this);
  };

  // Adds the item, or updates the one with its key in place (streaming partials and their final replacement).
  Store.prototype.upsert = function (item) {
    const k = key(item);
    const seen = k != null ? this.index.get(k) : null;
    if (seen == null) {
      return this.add([item])[0] || null;
    }
    if (item.partial === true && seen.partial !== true) {
      return seen;
    }
    return this.update(seen, item);
  };

  Store.prototype.update = function (target, fields) {
    Object.keys(fields).forEach(function (f) {
      if (f !== "k" && f !== "id" && f !== "tid") {
        target[f] = fields[f];
      }
    });
    if (fields.partial == null) {
      delete target.partial;
    }
    this.emit("items:update", { id: target.k === "result" ? target.tid : target.id, item: target });
    return target;
  };

  Store.prototype.partials = function () {
    return this.items.filter(function (it) {
      return it.partial === true;
    });
  };

  Store.prototype.setMeta = function (patch) {
    Object.assign(this.meta, patch || {});
    this.emit("state", this);
  };

  Store.prototype.setStatus = function (status, detail) {
    const changed = status !== this.status || (detail || null) !== this.statusDetail;
    this.status = status;
    this.statusDetail = detail || null;
    if (changed) {
      this.emit("state", this);
    }
  };

  Store.prototype.setPending = function (list) {
    this.pending = list || [];
    this.emit("state", this);
  };

  Store.prototype.addPending = function (req) {
    this.pending = this.pending.filter(function (p) {
      return p.requestId !== req.requestId;
    }).concat([req]);
    this.emit("state", this);
  };

  Store.prototype.removePending = function (match) {
    const before = this.pending.length;
    this.pending = this.pending.filter(function (p) {
      return !match(p);
    });
    if (this.pending.length !== before) {
      this.emit("state", this);
    }
  };

  // Subagent / background task state from system/task_* events, keyed by the tool_use_id that spawned the task.
  Store.prototype.setTask = function (toolUseId, patch) {
    const task = this.tasks.get(toolUseId) || { toolUseId: toolUseId };
    Object.assign(task, patch || {});
    this.tasks.set(toolUseId, task);
    this.emit("tasks", task);
    return task;
  };

  // The main agent's task list since the last /clear: TodoWrite snapshots (older models) or the TaskCreate /
  // TaskUpdate / TaskList tools, whose ids and list only appear in the result text (same in stream and transcript).
  Store.prototype.todos = function () {
    let list = null;
    const self = this;
    this.items.forEach(function (it) {
      if (it.k === "user" && it.command === true && CLEAR_RE.test(it.text)) {
        list = null;
      }
      if (it.k !== "tool" || it.agent != null || it.partial === true) {
        return;
      }
      const input = it.input || {};
      if (it.name === "TodoWrite") {
        list = Array.isArray(input.todos) ? input.todos.map(function (t) {
          return { content: t.content, activeForm: t.activeForm || null, status: t.status || "pending" };
        }) : list;
        return;
      }
      const r = self.resultOf(it.id);
      if (r == null || r.err) {
        return;
      }
      if (it.name === "TaskCreate") {
        const m = /^Task #(\S+) created/.exec(r.text || "");
        if (m != null) {
          list = (list || []).concat([{ id: m[1], content: input.subject || "", activeForm: input.activeForm || null, status: "pending" }]);
        }
      } else if (it.name === "TaskUpdate" && list != null) {
        list = list.filter(function (t) {
          return t.id !== input.taskId || input.status !== "deleted";
        }).map(function (t) {
          return t.id !== input.taskId ? t : { id: t.id, content: input.subject || t.content, activeForm: input.activeForm || t.activeForm, status: input.status || t.status };
        });
      } else if (it.name === "TaskList") {
        const known = list || [];
        list = (r.text || "").split("\n").map(function (line) {
          return /^#(\S+) \[(\w+)\] (.*?)(?: \[blocked by [^\]]*\])?$/.exec(line);
        }).filter(Boolean).map(function (m) {
          const prev = known.find(function (t) {
            return t.id === m[1];
          });
          return { id: m[1], content: m[3], activeForm: prev != null ? prev.activeForm : null, status: m[2] };
        });
      }
    });
    return list != null && list.length > 0 ? list : null;
  };

  Store.prototype.setHasOlder = function (has) {
    this.hasOlder = has === true;
    this.emit("state", this);
  };

  // Steps shown in a turn's timeline: tools (except the standalone cards) and thinking rows worth a line.
  function isStep(item) {
    if (item.k === "tool") {
      return item.agent == null && STANDALONE_TOOLS[item.name] !== true;
    }
    if (item.k === "thinking") {
      return item.agent == null && (!!item.text || (item.ms || 0) >= 3000);
    }
    return false;
  }

  // Consecutive step tools of one run kind share a card (Transcript); null = always a card of its own.
  function runKind(item) {
    return item.k === "tool" && isStep(item) ? RUN_KINDS[stepKind(item)] || null : null;
  }

  Store.prototype.failedCount = function (items) {
    const self = this;
    return items.filter(function (it) {
      const r = it.k === "tool" ? self.resultOf(it.id) : null;
      return r != null && r.err === true;
    }).length;
  };

  function thinkingLabel(item) {
    return item.ms ? "Thought for " + CC.util.fmtDuration(item.ms) : "Thinking";
  }

  Store.prototype.stepsLabel = function (items) {
    const counts = {};
    items.forEach(function (it) {
      const kind = stepKind(it);
      if (kind != null && kind !== "thinking") {
        counts[kind] = (counts[kind] || 0) + 1;
      }
    });
    const parts = [];
    STEP_KINDS.forEach(function (k) {
      const c = counts[k.kind] || 0;
      if (c > 0) {
        parts.push(c === 1 ? k.one : k.many.replace("#", c));
      }
    });
    const n = items.length;
    if (parts.length === 0) {
      const t = items.find(function (it) {
        return it.k === "thinking";
      });
      return n === 1 && t != null ? thinkingLabel(t) : n + (n === 1 ? " step" : " steps");
    }
    const s = parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0];
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // A finished turn's duration and output tokens: from its `turn` item (result / turn_duration) when it has them,
  // else from the prompt's timestamp to the last item or result and the output tokens of each API message.
  Store.prototype.turnStats = function (items, startTs, turn) {
    const self = this;
    let start = startTs ? Date.parse(startTs) : NaN;
    let end = turn != null && turn.ts ? Date.parse(turn.ts) : NaN;
    const out = {};
    items.forEach(function (it) {
      const r = it.k === "tool" ? self.resultOf(it.id) : null;
      [it.ts, r != null ? r.ts : null].forEach(function (ts) {
        const t = ts ? Date.parse(ts) : NaN;
        if (!isNaN(t)) {
          start = isNaN(start) ? t : start;
          end = isNaN(end) || t > end ? t : end;
        }
      });
      if (it.mid != null && it.out > 0) {
        out[it.mid] = Math.max(out[it.mid] || 0, it.out);
      }
    });
    const sum = Object.keys(out).reduce(function (a, k) {
      return a + out[k];
    }, 0);
    return {
      ms: turn != null && turn.ms ? turn.ms : !isNaN(start) && end > start ? end - start : null,
      tokens: turn != null && turn.tokens > 0 ? turn.tokens : sum > 0 ? sum : null,
      end: isNaN(end) ? null : end,
    };
  };

  Store.prototype.turnLabel = function (stats) {
    const parts = [];
    if (stats.ms > 0) {
      parts.push(CC.util.fmtDuration(stats.ms));
    }
    if (stats.tokens > 0) {
      parts.push(CC.util.fmtTokens(stats.tokens) + " tokens");
    }
    return parts.join(" · ");
  };

  // Files changed by the main thread's Edit / MultiEdit / Write / NotebookEdit items, from their results' patches (a
  // created file without hunks counts its whole content); `rel` maps the absolute paths.
  Store.prototype.editedFiles = function (items, rel) {
    const self = this;
    const files = [];
    const byPath = {};
    items.forEach(function (it) {
      if (it.k !== "tool" || it.agent != null || EDIT_TOOLS[it.name] !== true) {
        return;
      }
      const r = self.resultOf(it.id);
      const ex = r != null ? r.extra : null;
      const input = it.input || {};
      if (ex == null || !Array.isArray(ex.patch) || !input.file_path || r.err) {
        return;
      }
      let hunks = ex.patch;
      if (hunks.length === 0 && ex.created && typeof input.content === "string") {
        hunks = [{ oldStart: 0, newStart: 1, lines: input.content.replace(/\n$/, "").split("\n").map(function (l) {
          return "+" + l;
        }) }];
      }
      const path = rel != null ? rel(input.file_path) : input.file_path;
      let f = byPath[path];
      if (f == null) {
        f = { path: path, old: null, status: ex.created ? "added" : "modified", binary: false, add: 0, del: 0, hunks: [], truncated: false };
        byPath[path] = f;
        files.push(f);
      }
      hunks.forEach(function (h) {
        const lines = (h.lines || []).filter(function (l) {
          return l.charAt(0) === "+" || l.charAt(0) === "-" || l.charAt(0) === " ";
        });
        f.hunks.push({ o: h.oldStart || 0, n: h.newStart || 0, head: "", lines: lines });
        lines.forEach(function (l) {
          f.add += l.charAt(0) === "+" ? 1 : 0;
          f.del += l.charAt(0) === "-" ? 1 : 0;
        });
      });
    });
    return files;
  };

  // Assistant turns with their step groups, the same grouping the renderer uses: consecutive steps form one
  // group; text, standalone cards and task / interrupt notices start a new one.
  Store.prototype.turns = function () {
    const turns = [];
    let cur = null;
    let group = null;
    const self = this;
    function close(ended) {
      if (cur != null) {
        cur.ended = ended;
        turns.push(cur);
      }
      cur = null;
      group = null;
    }
    this.items.forEach(function (it) {
      if (it.k === "result" || it.agent != null) {
        return;
      }
      if (it.k === "user" || (it.k === "notice" && it.level !== "task" && it.level !== "interrupt")) {
        close(true);
        return;
      }
      if (it.k === "turn") {
        if (cur != null) {
          cur.ms = it.ms;
        }
        close(true);
        return;
      }
      if (cur == null) {
        cur = { items: [], groups: [], ms: null, ended: false };
      }
      cur.items.push(it);
      if (isStep(it)) {
        if (group == null) {
          group = { items: [], label: null, failed: 0 };
          cur.groups.push(group);
        }
        group.items.push(it);
      } else if (it.k === "thinking") {
        return;
      } else {
        group = null;
      }
    });
    if (cur != null) {
      close(false);
    }
    turns.forEach(function (t) {
      t.groups.forEach(function (g) {
        g.label = self.stepsLabel(g.items);
        g.failed = self.failedCount(g.items);
      });
    });
    return turns;
  };

  Store.stepKind = stepKind;
  Store.isStep = isStep;
  Store.runKind = runKind;
  Store.thinkingLabel = thinkingLabel;
  Store.STANDALONE_TOOLS = STANDALONE_TOOLS;
  return Store;
})();
