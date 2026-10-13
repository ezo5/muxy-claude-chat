window.CC = window.CC || {};
CC.adapters = CC.adapters || {};

// Daemon event envelopes ({seq, ts, ev}: raw Claude Code stream-json or daemon messages) → store items and state.
CC.adapters.events = (function () {
  const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  const INTERRUPTED = "[Request interrupted";
  const COMPACT_SUMMARY = "This session is being continued from a previous conversation";
  const CMD_RE = /<command-name>([\s\S]*?)<\/command-name>/;
  const ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
  const STDOUT_RE = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/;
  const RENAME_RE = /^\/rename\s+(.+?)\s*$/;
  const RENAMED_RE = /renamed(?: (?:the )?session)? to:?\s+["'`“]?([^"'`”\n]+)/i;
  const CLEAR_RE = /^\/(clear|reset|new)(\s|$)/;

  function clip(s, n) {
    const max = n || 40000;
    const str = String(s == null ? "" : s);
    return str.length > max ? str.slice(0, max) + "\n… (" + (str.length - max) + " more characters)" : str;
  }

  function textOf(content) {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return content.map(function (x) {
      if (x.type === "text") {
        return x.text || "";
      }
      return x.type === "image" ? "[image]" : "";
    }).filter(Boolean).join("\n");
  }

  const EXTRA_KEYS = ["numFiles", "numMatches", "durationMs", "status", "totalDurationMs", "totalTokens", "agentId", "code", "bytes", "url", "isAsync"];

  // Same shape as reader.py result_extra, from the stream's tool_use_result.
  function resultExtra(r) {
    if (r == null || typeof r !== "object" || Array.isArray(r)) {
      return null;
    }
    const ex = {};
    if (Array.isArray(r.structuredPatch)) {
      const hunks = [];
      let total = 0;
      for (const h of r.structuredPatch) {
        const lines = h.lines || [];
        if (total > 800) {
          break;
        }
        total += lines.length;
        hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines: lines.slice(0, 400).map(function (l) {
          return clip(l, 500);
        }) });
      }
      ex.patch = hunks;
      if (r.type === "create") {
        ex.created = true;
      }
    }
    if (r.stdout != null || r.stderr != null) {
      ex.stdout = clip(String(r.stdout || "").replace(ANSI, ""));
      ex.stderr = clip(String(r.stderr || "").replace(ANSI, ""), 4000);
      if (r.interrupted) {
        ex.interrupted = true;
      }
      if (r.backgroundTaskId) {
        ex.background = r.backgroundTaskId;
      }
      if (r.returnCodeInterpretation) {
        ex.rc = r.returnCodeInterpretation;
      }
    }
    if (r.file != null && typeof r.file === "object" && r.file.numLines != null) {
      ex.numLines = r.file.numLines;
      ex.totalLines = r.file.totalLines;
    }
    EXTRA_KEYS.forEach(function (k) {
      const v = r[k];
      if (v != null && (typeof v === "number" || typeof v === "string" || typeof v === "boolean")) {
        ex[k] = v;
      }
    });
    if (Array.isArray(r.filenames)) {
      ex.numFiles = r.filenames.length;
    }
    if (r.answers != null && typeof r.answers === "object") {
      ex.answers = r.answers;
    }
    return Object.keys(ex).length > 0 ? ex : null;
  }

  // Closes the open string and brackets of a JSON prefix; drops the trailing incomplete member when that fails.
  function closeJson(s) {
    const stack = [];
    let inStr = false;
    let esc = false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charAt(i);
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (c === "\\") {
          esc = true;
        } else if (c === '"') {
          inStr = false;
        }
      } else if (c === '"') {
        inStr = true;
      } else if (c === "{" || c === "[") {
        stack.push(c === "{" ? "}" : "]");
      } else if (c === "}" || c === "]") {
        stack.pop();
      }
    }
    let out = s;
    if (esc) {
      out = out.slice(0, -1);
    }
    if (inStr) {
      out += '"';
    }
    return out + stack.reverse().join("");
  }

  function partialJson(s) {
    let str = String(s || "").trim();
    if (str === "") {
      return {};
    }
    for (let i = 0; i < 4 && str !== ""; i++) {
      try {
        const v = JSON.parse(closeJson(str));
        return v != null && typeof v === "object" ? v : {};
      } catch (e) {
        const cut = str.lastIndexOf(",");
        str = cut > 0 ? str.slice(0, cut) : "";
      }
    }
    return {};
  }

  function iso(ts) {
    return typeof ts === "number" ? new Date(ts).toISOString() : ts || null;
  }

  function Events(store) {
    this.store = store;
    this.lastSeq = store.lastSeq || 0;
    this.blocks = {};
    this.partials = {};
    this.tasks = {};
    this.compact = null;
  }

  Events.prototype.feed = function (envelopes) {
    for (const env of envelopes || []) {
      if (env == null || env.ev == null || (env.seq != null && env.seq <= this.lastSeq)) {
        continue;
      }
      if (env.seq != null) {
        this.lastSeq = env.seq;
        this.store.lastSeq = env.seq;
      }
      try {
        this.handle(env.ev, iso(env.ts));
      } catch (e) {
        console.error("event failed", env.ev.type, e && e.message);
      }
    }
  };

  Events.prototype.handle = function (ev, ts) {
    const fn = this["on_" + ev.type];
    if (typeof fn === "function") {
      fn.call(this, ev, ts);
    }
  };

  Events.prototype.nextBlock = function (mid) {
    const n = this.blocks[mid] || 0;
    this.blocks[mid] = n + 1;
    return n;
  };

  Events.prototype.put = function (item, ev) {
    if (ev != null && ev.parent_tool_use_id != null) {
      item.agent = ev.parent_tool_use_id;
    }
    return this.store.upsert(item);
  };

  Events.prototype.on_assistant = function (ev, ts) {
    const msg = ev.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    const mid = msg.id || ev.uuid;
    if (msg.model && msg.model !== "<synthetic>") {
      this.store.setMeta({ modelId: msg.model });
    }
    for (const b of content) {
      const idx = this.nextBlock(mid);
      const bid = mid + ":" + idx;
      delete this.partials[bid];
      if (b.type === "text") {
        if (!(b.text || "").trim() || (msg.model === "<synthetic>" && b.text.indexOf("No response requested") === 0)) {
          continue;
        }
        const renamed = msg.model === "<synthetic>" ? RENAMED_RE.exec(b.text) : null;
        if (renamed != null) {
          this.store.setMeta({ title: renamed[1].trim() });
        }
        this.put({ k: "text", ts: ts, id: bid, text: b.text, err: ev.isApiErrorMessage === true }, ev);
      } else if (b.type === "thinking") {
        if ((b.thinking || "").trim() || ev.thinking_duration_ms) {
          this.put({ k: "thinking", ts: ts, id: bid, text: clip(b.thinking || "", 20000), ms: ev.thinking_duration_ms || null }, ev);
        }
      } else if (b.type === "tool_use" && b.name === "SubagentHandback" && b.input != null && typeof b.input.message === "string") {
        this.put({ k: "text", ts: ts, id: bid, text: b.input.message, err: false }, ev);
      } else if (b.type === "tool_use" || b.type === "server_tool_use") {
        delete this.partials[b.id];
        this.put({ k: "tool", ts: ts, id: b.id, name: b.name, input: b.input || {} }, ev);
      }
    }
    if (msg.usage != null && typeof msg.usage === "object" && ev.parent_tool_use_id == null) {
      const u = msg.usage;
      this.store.setMeta({ contextTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) });
    }
  };

  Events.prototype.on_user = function (ev, ts) {
    const msg = ev.message || {};
    let content = msg.content;
    const uid = ev.uuid || ("u" + this.lastSeq);
    if (typeof content === "string") {
      content = [{ type: "text", text: content }];
    }
    if (!Array.isArray(content)) {
      return;
    }
    const texts = [];
    let images = 0;
    for (const b of content) {
      if (b.type === "tool_result") {
        const item = { k: "result", ts: ts, tid: b.tool_use_id, err: b.is_error === true, text: clip(textOf(b.content).replace(ANSI, "")) };
        const ex = resultExtra(ev.tool_use_result != null ? ev.tool_use_result : ev.toolUseResult);
        if (ex != null) {
          item.extra = ex;
        }
        this.put(item, ev);
        this.store.removePending(function (p) {
          return p.request != null && p.request.tool_use_id === b.tool_use_id;
        });
      } else if (b.type === "text") {
        texts.push(b.text || "");
      } else if (b.type === "image") {
        images += 1;
      }
    }
    if (ev.isMeta || (texts.length === 0 && images === 0)) {
      return;
    }
    const txt = texts.join("\n").trim();
    if (txt.indexOf(INTERRUPTED) === 0) {
      this.put({ k: "notice", ts: ts, id: uid, level: "interrupt", text: "Interrupted" }, ev);
      return;
    }
    if (ev.isCompactSummary === true || txt.indexOf(COMPACT_SUMMARY) === 0) {
      if (this.compact != null) {
        this.store.update(this.compact, { detail: clip(txt, 20000) });
      } else {
        this.put({ k: "notice", ts: ts, id: uid, level: "compact", text: "Conversation compacted", detail: clip(txt, 20000) }, ev);
      }
      return;
    }
    let m = txt.indexOf("<command-") === 0 ? CMD_RE.exec(txt) : null;
    if (m != null) {
      const ma = ARGS_RE.exec(txt);
      this.put({ k: "user", ts: ts, id: uid, text: (m[1].trim() + " " + (ma != null ? ma[1].trim() : "")).trim(), command: true }, ev);
      return;
    }
    m = txt.indexOf("<local-command") === 0 ? STDOUT_RE.exec(txt) : null;
    if (m != null) {
      const out = m[2].replace(ANSI, "").trim();
      if (out) {
        this.put({ k: "notice", ts: ts, id: uid, level: "command", text: clip(out, 8000) }, ev);
      }
      return;
    }
    if (txt.indexOf("<local-command-caveat") === 0 || txt.indexOf("Caveat:") === 0 || txt.indexOf("<system-reminder") === 0) {
      return;
    }
    // The CLI does not echo our own prompts; subagent prompts are the only user texts on the stream.
    if (ev.parent_tool_use_id == null && !ev.isReplay) {
      return;
    }
    this.put({ k: "user", ts: ts, id: uid, text: clip(txt, 40000), images: images }, ev);
  };

  Events.prototype.on_stream_event = function (ev, ts) {
    const e = ev.event || {};
    const mid = ev.api_message_id || (e.message != null ? e.message.id : null);
    if (e.type === "content_block_start") {
      const b = e.content_block || {};
      const bid = mid + ":" + e.index;
      let item = null;
      if (b.type === "text") {
        item = { k: "text", ts: ts, id: bid, text: b.text || "", err: false, partial: true };
      } else if (b.type === "thinking") {
        item = { k: "thinking", ts: ts, id: bid, text: b.thinking || "", ms: null, partial: true };
      } else if (b.type === "tool_use" || b.type === "server_tool_use") {
        item = { k: "tool", ts: ts, id: b.id, name: b.name, input: b.input || {}, partial: true };
      }
      const stored = item != null ? this.put(item, ev) : null;
      if (stored != null && stored.partial === true) {
        this.partials[bid] = { item: stored, json: "" };
      }
      return;
    }
    if (e.type === "content_block_delta") {
      const p = this.partials[mid + ":" + e.index];
      const d = e.delta || {};
      if (p == null || p.item.partial !== true) {
        return;
      }
      if (d.type === "text_delta" && d.text) {
        this.store.update(p.item, { text: p.item.text + d.text, partial: true });
      } else if (d.type === "thinking_delta" && d.thinking) {
        this.store.update(p.item, { text: p.item.text + d.thinking, partial: true });
      } else if (d.type === "input_json_delta" && d.partial_json) {
        p.json += d.partial_json;
        this.store.update(p.item, { input: partialJson(p.json), partial: true });
      }
      return;
    }
    if (e.type === "message_stop") {
      this.finishPartials(mid);
    }
  };

  // Partials the final assistant message never replaced (interrupts, aborted streams) stop being partial.
  Events.prototype.finishPartials = function (mid) {
    const self = this;
    Object.keys(this.partials).forEach(function (bid) {
      const p = self.partials[bid];
      if ((mid == null || bid.indexOf(mid + ":") === 0) && p.item.partial === true) {
        self.store.update(p.item, {});
      }
      delete self.partials[bid];
    });
  };

  Events.prototype.on_result = function (ev, ts) {
    this.finishPartials(null);
    const meta = { cost: ev.total_cost_usd, usage: ev.usage || null };
    if (ev.modelUsage != null) {
      meta.tokens = this.tokenTotals(ev.modelUsage);
    }
    if (ev.usage != null) {
      const u = ev.usage;
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (ctx > 0) {
        meta.contextTokens = ctx;
      }
    }
    this.store.setMeta(meta);
    if (ev.is_error && ev.result) {
      this.put({ k: "notice", ts: ts, id: "err:" + (ev.uuid || this.lastSeq), level: "error", text: clip(String(ev.result), 4000) });
    }
    if (ev.num_turns === 0 && !ev.duration_ms) {
      return;
    }
    this.put({ k: "turn", ts: ts, id: "turn:" + (ev.uuid || this.lastSeq), ms: ev.duration_ms || 0, tokens: ev.usage != null ? ev.usage.output_tokens || null : null, subtype: ev.subtype });
    this.store.setPending([]);
  };

  // modelUsage is cumulative per CLI process (subagents and compaction included) and restarts at zero after /clear;
  // sum = [input, cache write, cache read, output] over all processes, base = the process's last cumulative value.
  Events.prototype.tokenTotals = function (modelUsage) {
    const cur = [0, 0, 0, 0];
    Object.keys(modelUsage).forEach(function (k) {
      const m = modelUsage[k] || {};
      cur[0] += m.inputTokens || 0;
      cur[1] += m.cacheCreationInputTokens || 0;
      cur[2] += m.cacheReadInputTokens || 0;
      cur[3] += m.outputTokens || 0;
    });
    const prev = this.store.meta.tokens || { sum: [0, 0, 0, 0], base: [0, 0, 0, 0] };
    const base = cur.some(function (v, i) {
      return v < prev.base[i];
    }) ? [0, 0, 0, 0] : prev.base;
    return { sum: prev.sum.map(function (v, i) {
      return v + cur[i] - base[i];
    }), base: cur };
  };

  Events.prototype.on_system = function (ev, ts) {
    const st = ev.subtype;
    const uid = ev.uuid || (st + ":" + this.lastSeq);
    if (st === "init") {
      const meta = {
        sessionId: ev.session_id, cwd: ev.cwd, modelId: ev.model, permissionMode: ev.permissionMode, cliVersion: ev.claude_code_version,
        capabilities: ev.capabilities || [], skills: ev.skills || [], outputStyle: ev.output_style,
      };
      if (this.store.meta.firstCliSessionId == null && ev.session_id) {
        meta.firstCliSessionId = ev.session_id;
      }
      this.store.setMeta(meta);
    } else if (st === "session_title_changed" && ev.title) {
      this.store.setMeta({ title: ev.title });
    } else if (st === "compact_boundary") {
      const meta = ev.compact_metadata || {};
      this.compact = this.put({ k: "notice", ts: ts, id: uid, level: "compact", text: "Conversation compacted", trigger: meta.trigger || null });
    } else if (st === "permission_denied") {
      this.put({ k: "notice", ts: ts, id: uid, level: "warning", text: "Permission denied: " + (ev.tool_name || "tool") + (ev.reason ? " — " + ev.reason : "") });
      const tid = ev.tool_use_id;
      this.store.removePending(function (p) {
        return p.request != null && p.request.tool_use_id === tid;
      });
    } else if (st === "status") {
      this.store.setMeta({ activity: ev.status || null });
    } else if (st === "task_started") {
      this.tasks[ev.task_id] = ev;
      if (ev.tool_use_id) {
        this.store.setTask(ev.tool_use_id, { taskId: ev.task_id, description: ev.description || null, type: ev.subagent_type || ev.task_type || null,
          backgrounded: ev.is_backgrounded === true, status: "running", startedAt: ts, endedAt: null });
      }
    } else if (st === "task_updated") {
      const started = this.tasks[ev.task_id];
      const patch = ev.patch || {};
      if (started != null && started.tool_use_id && (patch.status || patch.end_time)) {
        this.store.setTask(started.tool_use_id, { status: patch.status || "running", endedAt: patch.end_time != null ? iso(patch.end_time) : ts });
      }
    } else if (st === "task_notification") {
      const task = this.tasks[ev.task_id] || {};
      const tid = ev.tool_use_id || task.tool_use_id;
      if (tid) {
        this.store.setTask(tid, { status: ev.status || "completed", summary: ev.summary || null, endedAt: ts, ms: ev.usage != null ? ev.usage.duration_ms || null : null, outputFile: ev.output_file || null });
      }
      if (task.is_backgrounded === true) {
        this.put({ k: "notice", ts: ts, id: uid, level: "task", text: (task.description || ev.summary || "Background task") + (ev.summary && task.description ? ": " + ev.summary : ""), status: ev.status || null });
      }
    } else if ((st === "informational" || st === "api_error") && ev.content) {
      this.put({ k: "notice", ts: ts, id: uid, level: ev.level || (st === "api_error" ? "error" : "info"), text: clip(String(ev.content).replace(ANSI, ""), 4000) });
    }
  };

  // /clear: the CLI continues in a new transcript; the earlier conversation stays above the divider.
  Events.prototype.on_conversation_reset = function (ev, ts) {
    const last = this.store.items.filter(function (it) {
      return it.k === "user";
    }).pop();
    if (last == null || last.command !== true || !CLEAR_RE.test(last.text)) {
      this.put({ k: "user", ts: ts, id: ev.uuid || ("reset:" + this.lastSeq), text: "/clear", command: true });
    }
    if (ev.new_conversation_id) {
      this.store.setMeta({ suggestion: null, cliSessionId: ev.new_conversation_id, resets: (this.store.meta.resets || []).concat([{ from: this.store.meta.cliSessionId || null, to: ev.new_conversation_id, ts: ts }]) });
    }
  };

  Events.prototype.on_control_request = function (ev, ts) {
    const req = ev.request || {};
    if (req.subtype === "can_use_tool") {
      this.store.addPending({ requestId: ev.request_id, request: req, ts: ts });
    }
  };

  Events.prototype.on_control_response = function (ev) {
    const res = ev.response || {};
    const body = res.response || {};
    if (res.request_id === "init" || body.commands != null) {
      this.store.setMeta({ commands: body.commands || [], models: body.models || [], account: body.account || null, outputStyle: body.output_style || this.store.meta.outputStyle });
    }
  };

  // Predicted next prompt, sent after a turn's result (initialize promptSuggestions); a new prompt or /clear drops it.
  Events.prototype.on_prompt_suggestion = function (ev) {
    this.store.setMeta({ suggestion: ev.suggestion || null });
  };

  Events.prototype.on_rate_limit_event = function (ev) {
    this.store.setMeta({ rateLimit: ev.rate_limit_info || null });
  };

  Events.prototype.on_daemon = function (ev, ts) {
    const st = ev.subtype;
    const uid = "daemon:" + this.lastSeq;
    if (st === "started") {
      const meta = { daemon: { pid: ev.pid, cliVersion: ev.cliVersion, resumed: ev.resumed === true } };
      if (this.store.meta.tokens != null) {
        meta.tokens = { sum: this.store.meta.tokens.sum, base: [0, 0, 0, 0] };
      }
      const argv = Array.isArray(ev.argv) ? ev.argv : [];
      const at = Math.max(argv.indexOf("--resume"), argv.indexOf("--session-id"));
      if (this.store.meta.firstCliSessionId == null && at >= 0 && argv[at + 1]) {
        meta.firstCliSessionId = argv[at + 1];
      }
      this.store.setMeta(meta);
    } else if (st === "stopped") {
      this.finishPartials(null);
      if (ev.reason !== "stop") {
        this.put({ k: "notice", ts: ts, id: uid, level: ev.reason === "error" || ev.exitCode ? "error" : "info", text: "Claude stopped" + (ev.reason ? " (" + ev.reason + ")" : "") });
      }
      this.store.setStatus("stopped", ev.reason || null);
    } else if (st === "accepted" && ev.cmd === "prompt" && typeof ev.text === "string") {
      this.store.setMeta({ suggestion: null });
      const item = { k: "user", ts: ts, id: "inbox:" + ev.id, text: ev.text, images: ev.images || 0, inboxId: ev.id, clientId: ev.clientId || null, uuid: ev.uuid || null };
      if (/^\/[\w:-]+(\s|$)/.test(ev.text)) {
        item.command = true;
      }
      this.put(item);
      const renamed = RENAME_RE.exec(ev.text);
      if (renamed != null) {
        this.store.setMeta({ title: renamed[1] });
      }
    } else if (st === "rejected" || st === "error") {
      this.put({ k: "notice", ts: ts, id: uid, level: "error", text: ev.error || "Daemon error" });
    } else if (st === "rewound") {
      this.rewound(ev.target);
    } else if (st === "control_result") {
      this.store.emit("control", { id: ev.id, response: ev.response });
    }
  };

  // The target bubble and everything after it go; a target not in the store is in the history not loaded yet (replay
  // after a reload), so every item so far comes after it.
  Events.prototype.rewound = function (target) {
    const store = this.store;
    const at = store.items.findIndex(function (it) {
      return it.k === "user" && (it.uuid === target || it.id === target);
    });
    store.truncate(at);
    if (this.compact != null && store.items.indexOf(this.compact) < 0) {
      this.compact = null;
    }
    store.setMeta({ suggestion: null });
  };

  // state.json → store status / pending / meta (the `events` and `wait` ops return it with the events).
  Events.prototype.state = function (s) {
    if (s == null) {
      return;
    }
    const meta = {};
    ["model", "effort", "permissionMode", "contextUsage", "rateLimit", "cost", "usage", "cwd", "sessionId", "cliSessionId", "models", "commands",
      "capabilities", "cliVersion", "turn", "activity", "stoppedAt", "title"].forEach(function (k) {
      if (s[k] != null) {
        meta[k] = s[k];
      }
    });
    this.store.setMeta(meta);
    if (Array.isArray(s.pending)) {
      this.store.setPending(s.pending);
    }
    if (s.status) {
      this.store.setStatus(s.status, s.reason || null);
    }
  };

  return { Events: Events, partialJson: partialJson, resultExtra: resultExtra, textOf: textOf };
})();
