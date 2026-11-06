// What a tool call looks like at each level of the work disclosure: its kind for the summary line (level 1), its intent label
// (level 2) and its detail (level 3). No state: label and detail are functions of the item and its result.
CC.toolDetail = (function () {
  const util = CC.util;
  const el = util.el;
  const md = CC.markdown;
  const conv = CC.conv;

  const SUMMARY = {
    edit: ["edited a file", "edited # files"],
    create: ["created a file", "created # files"],
    bash: ["ran a command", "ran # commands"],
    read: ["read a file", "read # files"],
    search: ["searched the code", "searched the code # times"],
    web: ["checked the web", "checked the web # times"],
    agent: ["ran an agent", "ran # agents"],
    skill: ["ran a skill", "ran # skills"],
    tools: ["loaded tools", "loaded tools # times"],
    task: ["updated tasks", "updated tasks # times"],
    message: ["sent a message", "sent # messages"],
    generic: ["used a tool", "used # tools"],
  };

  const KIND = {
    Bash: "bash", BashOutput: "bash", KillShell: "bash", KillBash: "bash", Monitor: "bash", TaskStop: "bash", Read: "read", NotebookRead: "read", Grep: "search", Glob: "search", LS: "search",
    Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", WebFetch: "web", WebSearch: "web", Agent: "agent", Task: "agent", Skill: "skill",
    ToolSearch: "tools", TaskCreate: "task", TaskUpdate: "task", TaskList: "task", TaskGet: "task", SendMessage: "message",
  };

  function filePath(input) {
    return input.file_path || input.notebook_path || "";
  }

  function kindOf(item, result) {
    if (item.name === "Write") {
      const created = result != null && result.extra != null && result.extra.created === true;
      return created || result == null ? "create" : "edit";
    }
    return KIND[item.name] || "generic";
  }

  // One grey line. At most three kinds are named, in the order they first ran; the rest is counted.
  function summary(items, resultOf) {
    const order = [];
    const counts = {};
    const files = {};
    items.forEach(function (it) {
      if (it.k !== "tool") {
        return;
      }
      const kind = kindOf(it, resultOf(it.id));
      if (counts[kind] == null) {
        counts[kind] = 0;
        files[kind] = new Set();
        order.push(kind);
      }
      const path = filePath(it.input || {});
      if ((kind === "edit" || kind === "create" || kind === "read") && path) {
        if (!files[kind].has(path)) {
          files[kind].add(path);
          counts[kind] += 1;
        }
      } else {
        counts[kind] += 1;
      }
    });
    const parts = order.slice(0, 3).map(function (kind) {
      const c = counts[kind];
      if ((kind === "edit" || kind === "create") && c === 1 && files[kind].size === 1) {
        return (kind === "edit" ? "edited " : "created ") + conv.baseName(Array.from(files[kind])[0]);
      }
      return c === 1 ? SUMMARY[kind][0] : SUMMARY[kind][1].replace("#", c);
    });
    const rest = order.slice(3).reduce(function (a, kind) {
      return a + counts[kind];
    }, 0);
    if (rest > 0) {
      parts.push("and " + conv.plural(rest, "more action", "more actions"));
    }
    const s = parts.join(", ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function shortUrl(u) {
    const m = /^https?:\/\/(?:www\.)?([^/?#]+)([^?#]*)/.exec(String(u || ""));
    if (m == null) {
      return String(u || "");
    }
    const parts = m[2].split("/").filter(Boolean);
    return m[1] + (parts.length > 2 ? "/…/" + parts[parts.length - 1] : parts.length > 0 ? "/" + parts.join("/") : "");
  }

  function firstString(input) {
    const key = Object.keys(input).find(function (k) {
      return typeof input[k] === "string" && input[k].length > 0;
    });
    return key != null ? util.firstLine(input[key], 140) : "";
  }

  function mcpName(name) {
    const parts = String(name).split("__");
    return parts.length >= 3 && parts[0] === "mcp" ? { server: conv.humanize(parts[1].replace(/^plugin_/, "").replace(/^claude_ai_/, "")), tool: conv.humanize(parts.slice(2).join(" ")) } : null;
  }

  function lineDiff(oldStr, newStr) {
    const a = oldStr ? String(oldStr).split("\n") : [];
    const b = String(newStr || "").split("\n");
    if (a.length * b.length > 250000) {
      return a.map(function (l) {
        return "-" + l;
      }).concat(b.map(function (l) {
        return "+" + l;
      }));
    }
    const n = a.length;
    const m = b.length;
    const t = [];
    for (let i = n; i >= 0; i--) {
      t[i] = new Uint32Array(m + 1);
      for (let j = m - 1; i < n && j >= 0; j--) {
        t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        out.push(" " + a[i]);
        i++;
        j++;
      } else if (i < n && (j >= m || t[i + 1][j] >= t[i][j + 1])) {
        out.push("-" + a[i]);
        i++;
      } else {
        out.push("+" + b[j]);
        j++;
      }
    }
    return out;
  }

  // The hunks of a call: the result's patch once there, the streamed input before it.
  function hunksOf(item, result) {
    const input = item.input || {};
    const patch = result != null && result.extra != null ? result.extra.patch : null;
    if (Array.isArray(patch) && patch.length > 0 && item.name !== "Write") {
      return patch;
    }
    if (item.name === "Write") {
      return [{ oldStart: 0, newStart: 1, lines: String(input.content || "").replace(/\n$/, "").split("\n").map(function (l) {
        return "+" + l;
      }) }];
    }
    if (item.name === "MultiEdit" && Array.isArray(input.edits)) {
      return input.edits.map(function (e) {
        return { oldStart: 0, newStart: 0, lines: lineDiff(e.old_string, e.new_string) };
      });
    }
    if (input.old_string != null || input.new_string != null) {
      return [{ oldStart: 0, newStart: 0, lines: lineDiff(input.old_string, input.new_string) }];
    }
    return [];
  }

  function countLines(hunks) {
    const n = { add: 0, del: 0 };
    hunks.forEach(function (h) {
      (h.lines || []).forEach(function (l) {
        n.add += l.charAt(0) === "+" ? 1 : 0;
        n.del += l.charAt(0) === "-" ? 1 : 0;
      });
    });
    return n;
  }

  // {verb, name (bold), text, code (monospace), add, del, failed, note, tip}. Says what was meant, not which tool ran.
  function label(item, result, ctx) {
    const input = item.input || {};
    const name = item.name;
    const out = { verb: "", name: "", text: "", code: "", add: null, del: null, failed: result != null && result.err === true, note: "", tip: "" };
    const ex = result != null ? result.extra || {} : {};
    const path = filePath(input);
    if (name === "Bash") {
      out.tip = String(input.command || "");
      if (input.description) {
        out.text = String(input.description);
      } else {
        out.code = util.firstLine(input.command || "", 200);
      }
      if (ex.interrupted) {
        out.note = "interrupted";
      } else if (input.run_in_background || ex.background) {
        out.note = "in background";
      }
    } else if (name === "Read" || name === "NotebookRead") {
      out.verb = "Read";
      out.name = conv.baseName(path);
      out.tip = path;
      if (input.offset != null || input.limit != null) {
        const from = input.offset || 1;
        out.note = input.limit != null ? "lines " + from + "–" + (from + input.limit - 1) : "from line " + from;
      }
    } else if (name === "Edit" || name === "MultiEdit" || name === "Write" || name === "NotebookEdit") {
      out.verb = name === "Write" ? (result == null || ex.created ? "Created" : "Wrote") : "Edited";
      if (out.failed) {
        out.verb = name === "Write" ? "Couldn't write" : "Couldn't edit";
      }
      out.name = conv.baseName(path);
      out.tip = path;
      const n = countLines(hunksOf(item, result));
      if (!out.failed && n.add + n.del > 0) {
        out.add = n.add;
        out.del = n.del;
      }
    } else if (name === "Grep" || name === "Glob") {
      out.verb = name === "Glob" ? "Found files" : "Searched for";
      out.code = String(input.pattern || input.query || "") + (input.glob ? " in " + input.glob : "");
      out.tip = input.path || "";
      out.note = ex.numFiles != null ? conv.plural(ex.numFiles, "file", "files") : ex.numMatches != null ? conv.plural(ex.numMatches, "match", "matches") : "";
    } else if (name === "LS") {
      out.verb = "Listed";
      out.name = util.shortPath(input.path, ctx.cwd) || ".";
    } else if (name === "WebFetch") {
      out.verb = "Read page";
      out.text = shortUrl(input.url);
      out.tip = input.url || "";
      out.note = ex.code && (ex.code < 200 || ex.code >= 300) ? "HTTP " + ex.code : "";
    } else if (name === "WebSearch") {
      out.verb = "Searched the web for";
      out.text = String(input.query || "");
    } else if (name === "Agent" || name === "Task") {
      const type = String(input.subagent_type || "");
      out.verb = type && type !== "general-purpose" ? conv.humanize(type) + " agent" : "Agent";
      out.text = String(input.description || "");
      out.note = ex.totalDurationMs ? util.fmtDuration(ex.totalDurationMs) : "";
    } else if (name === "Skill") {
      out.verb = "Ran skill";
      out.name = "/" + String(input.skill || input.command || "").replace(/^\//, "");
    } else if (name === "ToolSearch") {
      out.verb = "Loaded tools";
    } else if (name === "TaskCreate") {
      out.verb = "Added task";
      out.text = String(input.subject || "");
    } else if (name === "TaskUpdate") {
      out.verb = input.status === "completed" ? "Finished task" : "Updated task";
      out.text = String(input.subject || "#" + (input.taskId || ""));
    } else if (name === "TaskList" || name === "TaskGet") {
      out.verb = "Checked tasks";
    } else if (name === "TaskStop" || name === "KillShell" || name === "KillBash") {
      out.verb = "Stopped a background task";
    } else if (name === "BashOutput") {
      out.verb = "Checked background output";
    } else if (name === "Monitor") {
      out.text = String(input.description || "Watched a background task");
    } else if (name === "SendMessage") {
      out.verb = "Sent a message";
      out.text = input.to ? "to " + input.to : "";
    } else {
      const mcp = mcpName(name);
      out.verb = mcp != null ? mcp.tool : conv.humanize(name);
      out.text = firstString(input);
      out.note = mcp != null ? mcp.server : "";
      out.tip = String(name);
    }
    return out;
  }

  // What a call works on, in one line, for the live line and the agent step rail.
  function target(item) {
    const i = item.input || {};
    const file = filePath(i);
    if (file) {
      return conv.baseName(file);
    }
    const v = i.command || i.pattern || i.query || i.url || i.description || i.skill || i.path || "";
    return util.firstLine(String(v), 120);
  }

  // Level 3 parts.

  function pathRow(path, ctx) {
    const row = el("div", "cv-detail-path");
    const link = el("span", "path-link", util.shortPath(path, ctx.cwd));
    link.dataset.path = path;
    link.title = path + "\nClick to open (Cmd+click copies)";
    row.appendChild(link);
    return row;
  }

  // A file in the bounded viewer: line numbers, highlighting, its own scroll.
  function viewer(text, lang, startLine) {
    const box = el("div", "cv-viewer");
    const lines = text.split("\n");
    const gutter = el("div", "cv-gutter");
    gutter.textContent = lines.map(function (l, i) {
      return String(startLine + i);
    }).join("\n");
    const pre = el("pre");
    const code = el("code", "hljs");
    code.innerHTML = md.highlight(text, lang);
    pre.appendChild(code);
    box.append(gutter, pre, conv.copyButton(function () {
      return text;
    }));
    return box;
  }

  function outputBlock(text, title, err) {
    const block = md.codeBlock(text, "plaintext", { title: title });
    block.classList.add("output");
    if (err) {
      block.classList.add("err");
    }
    return block;
  }

  function diffView(hunks) {
    const wrap = el("div", "cv-viewer cv-diff");
    const inner = el("div", "cv-diff-lines");
    hunks.forEach(function (h, idx) {
      if (idx > 0) {
        inner.appendChild(el("div", "diff-line hunk", "⋯"));
      }
      let oldNo = h.oldStart || 0;
      let newNo = h.newStart || 0;
      const numbered = oldNo > 0 || newNo > 0;
      (h.lines || []).forEach(function (line) {
        const sign = line.charAt(0);
        const row = el("div", "diff-line");
        const num = el("span", "ln");
        if (sign === "+") {
          row.classList.add("add");
          num.textContent = newNo;
          newNo += 1;
        } else if (sign === "-") {
          row.classList.add("del");
          num.textContent = oldNo;
          oldNo += 1;
        } else {
          num.textContent = newNo;
          oldNo += 1;
          newNo += 1;
        }
        if (!numbered) {
          num.textContent = "";
        }
        row.append(num, el("span", "sign", sign === "+" || sign === "-" ? sign : " "), el("span", "code", line.slice(1)));
        inner.appendChild(row);
      });
    });
    wrap.appendChild(inner);
    return wrap;
  }

  function params(input) {
    const box = el("div", "cv-params");
    const list = el("dl", "cv-kv");
    Object.keys(input).forEach(function (k) {
      const v = input[k];
      list.appendChild(el("dt", null, conv.humanize(k)));
      list.appendChild(el("dd", typeof v === "string" ? null : "is-code", typeof v === "string" ? v : JSON.stringify(v)));
    });
    box.appendChild(list);
    const raw = el("details", "cv-raw");
    raw.appendChild(el("summary", null, "Raw input"));
    raw.appendChild(md.codeBlock(JSON.stringify(input, null, 2), "json", { title: "Input" }));
    box.appendChild(raw);
    return box;
  }

  const details = {};

  details.Bash = function (host, item, result) {
    const input = item.input || {};
    host.appendChild(md.codeBlock(String(input.command || ""), "bash", { title: "Command" }));
    if (result == null) {
      return;
    }
    const ex = result.extra || {};
    const out = ex.stdout != null ? ex.stdout : conv.resultText(result);
    if (out) {
      host.appendChild(outputBlock(out, "Output", result.err && !ex.stderr));
    }
    if (ex.stderr) {
      host.appendChild(outputBlock(ex.stderr, "Errors", true));
    }
    if (!out && !ex.stderr && result.text) {
      host.appendChild(outputBlock(result.text, "Output", result.err));
    }
  };

  function editDetail(host, item, result, ctx) {
    const input = item.input || {};
    const path = filePath(input);
    if (path) {
      host.appendChild(pathRow(path, ctx));
    }
    if (item.name === "Write" && md.langFromPath(path) === "markdown") {
      host.appendChild(md.fileBlock(String(input.content || ""), path, { title: util.shortPath(path, ctx.cwd), cwd: ctx.cwd }));
    } else {
      const hunks = hunksOf(item, result);
      if (hunks.length > 0) {
        host.appendChild(diffView(hunks));
      }
    }
    if (result != null && result.err) {
      host.appendChild(outputBlock(conv.resultText(result), "Error", true));
    }
  }
  details.Edit = editDetail;
  details.MultiEdit = editDetail;
  details.Write = editDetail;
  details.NotebookEdit = editDetail;

  details.Read = function (host, item, result, ctx) {
    const path = filePath(item.input || {});
    host.appendChild(pathRow(path, ctx));
    if (result == null) {
      return;
    }
    if (result.err) {
      host.appendChild(outputBlock(conv.resultText(result), "Error", true));
    } else if (result.text) {
      const raw = conv.resultText(result);
      const first = /^ *(\d+)\t/.exec(raw);
      const text = raw.replace(/^ *\d+\t/gm, "");
      if (md.langFromPath(path) === "markdown") {
        host.appendChild(md.fileBlock(text, path, { title: util.shortPath(path, ctx.cwd), cwd: ctx.cwd }));
      } else {
        host.appendChild(viewer(text, md.langFromPath(path), first != null ? Number(first[1]) : (item.input || {}).offset || 1));
      }
    }
  };
  details.NotebookRead = details.Read;

  function searchDetail(host, item, result, ctx) {
    const where = (item.input || {}).path;
    if (where) {
      host.appendChild(pathRow(where, ctx));
    }
    if (result != null && result.text) {
      host.appendChild(outputBlock(conv.resultText(result), "Results", result.err));
    }
  }
  details.Grep = searchDetail;
  details.Glob = searchDetail;
  details.LS = searchDetail;

  function webDetail(host, item, result, ctx) {
    const input = item.input || {};
    if (input.url) {
      const a = el("a", null, input.url);
      a.href = "#";
      a.dataset.href = input.url;
      const row = el("div", "cv-detail-path md");
      row.appendChild(a);
      host.appendChild(row);
    }
    if (result != null && result.text) {
      const box = el("div", "cv-viewer cv-viewer-md");
      box.appendChild(md.render(conv.resultText(result), { cwd: ctx.cwd }));
      host.appendChild(box);
    }
  }
  details.WebFetch = webDetail;
  details.WebSearch = webDetail;

  details.Skill = function (host, item, result) {
    const args = (item.input || {}).args;
    if (args) {
      host.appendChild(el("div", "cv-detail-path", String(args)));
    }
    if (result != null && result.text) {
      host.appendChild(outputBlock(conv.resultText(result), "Result", result.err));
    }
  };

  const HANDBACK_POINTER = /report was delivered to you as a message from .*SubagentHandback call/;
  const RAIL_SHOWN = 5;

  // The subagent's latest steps, then its prompt and result. Its whole transcript is the rail's `agent` pane.
  function agentDetail(host, item, result, ctx) {
    const input = item.input || {};
    const steps = ctx.agentSteps != null ? ctx.agentSteps(item.id) : [];
    const ex = result != null ? result.extra || {} : {};
    const info = el("div", "cv-agent-info");
    if (ex.resolvedModel) {
      const m = el("span", null, util.prettyModel(ex.resolvedModel));
      m.title = ex.resolvedModel;
      info.appendChild(m);
    }
    if (steps.length > 0) {
      info.appendChild(el("span", null, conv.plural(steps.length, "step", "steps")));
    }
    if (ex.isAsync) {
      info.appendChild(el("span", null, "in background"));
    }
    if (ex.totalTokens) {
      info.appendChild(el("span", null, util.fmtTokens(ex.totalTokens) + " tokens"));
    }
    if (info.childNodes.length > 0) {
      host.appendChild(info);
    }
    if (steps.length > 0) {
      const rail = el("div", "cv-agent-rail");
      steps.slice(-RAIL_SHOWN).forEach(function (it) {
        const row = el("div", "cv-rail-step");
        if (it.k === "tool") {
          const r = ctx.resultOf(it.id);
          row.classList.add(r == null ? "is-running" : r.err ? "is-failed" : "is-done");
          row.append(el("span", "cv-rail-name", it.name), el("span", "cv-rail-target", target(it)));
        } else {
          row.appendChild(el("span", "cv-rail-target", util.firstLine(it.text.trim(), 200)));
        }
        rail.appendChild(row);
      });
      host.appendChild(rail);
    }
    if (input.prompt) {
      const det = el("details", "cv-raw");
      det.appendChild(el("summary", null, "Prompt"));
      det.appendChild(md.render(String(input.prompt), { cwd: ctx.cwd }));
      host.appendChild(det);
    }
    if (result != null && result.text && !HANDBACK_POINTER.test(result.text)) {
      const res = el("div", "cv-viewer cv-viewer-md");
      res.appendChild(md.render(conv.resultText(result), { cwd: ctx.cwd }));
      host.appendChild(res);
    }
  }
  details.Agent = agentDetail;
  details.Task = agentDetail;

  function genericDetail(host, item, result) {
    const input = item.input || {};
    if (Object.keys(input).length > 0) {
      host.appendChild(params(input));
    }
    if (result != null && result.text) {
      host.appendChild(outputBlock(conv.resultText(result), "Result", result.err));
    }
  }

  // ctx: {cwd, resultOf, agentSteps}
  function detail(item, result, ctx) {
    const host = el("div", "cv-detail");
    (details[item.name] || genericDetail)(host, item, result, ctx);
    return host;
  }

  // Answered questions and plans are history in the flow, in the composer's compact form. Still open, they are C3's card at the end of the flow.
  function answeredRows(item, result) {
    const qs = (item.input || {}).questions || [];
    const answers = result != null && result.extra != null ? result.extra.answers || {} : {};
    const fallback = Object.keys(answers).length === 0 && result != null ? conv.resultText(result) : "";
    return qs.map(function (q, i) {
      const a = answers[q.question];
      return { q: q.question, a: a != null ? String(a) : i === 0 && fallback ? fallback : "Not answered" };
    });
  }

  function answered(item, result) {
    return CC.Composer.answeredNode(answeredRows(item, result));
  }

  function plan(item, result, ctx) {
    const box = el("div", "cv-plan");
    const reason = result != null && result.err ? conv.resultText(result).trim() : "";
    const a = result == null ? "Not answered" : !result.err ? "Approved" : reason !== "" && reason !== "Keep planning." ? "Keep planning: " + reason : "Keep planning";
    box.appendChild(CC.Composer.answeredNode([{ q: "Plan", a: a }]));
    box.appendChild(CC.ui.disclosure({
      label: "Show the plan",
      body: function (host) {
        host.appendChild(md.render(String((item.input || {}).plan || ""), { cwd: ctx.cwd }));
      },
    }));
    return box;
  }

  // The diff of a pending Edit, MultiEdit or Write from its input, for the approval card. {node, add, del}, or null without any.
  function inputDiff(name, input) {
    const hunks = hunksOf({ name: name, input: input || {} }, null);
    if (hunks.length === 0) {
      return null;
    }
    const n = countLines(hunks);
    return { node: diffView(hunks), add: n.add, del: n.del };
  }

  return { kindOf: kindOf, summary: summary, label: label, target: target, detail: detail, answered: answered, answeredRows: answeredRows, plan: plan, inputDiff: inputDiff, hunksOf: hunksOf, countLines: countLines };
})();

CC.tools = { inputDiff: CC.toolDetail.inputDiff };
