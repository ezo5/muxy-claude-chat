window.CC = window.CC || {};

CC.tools = (function () {
  const util = CC.util;
  const el = util.el;
  const md = CC.markdown;

  function card(kind, iconName, opts) {
    const o = opts || {};
    const root = el("div", "tool tool-" + kind + " pending");
    const head = el("div", "tool-head");
    head.appendChild(util.icon(iconName));
    const title = el("div", "tool-title");
    head.appendChild(title);
    const meta = el("span", "tool-meta");
    head.appendChild(meta);
    head.appendChild(el("span", "tool-state"));
    const chev = util.icon("chevron");
    chev.classList.add("chev");
    head.appendChild(chev);
    const body = el("div", "tool-body");
    root.append(head, body);
    head.addEventListener("click", function () {
      if (body.childNodes.length > 0) {
        root.classList.toggle("open");
      }
    });
    if (o.open) {
      root.classList.add("open");
    }
    return { root: root, head: head, title: title, meta: meta, body: body };
  }

  function setTitle(c, verb, target, mono, tip) {
    c.title.textContent = "";
    c.title.appendChild(el("span", "tool-verb", verb));
    if (target) {
      c.title.appendChild(el("span", "tool-target" + (mono ? " mono" : ""), target));
    }
    c.head.title = tip || "";
  }

  function setVerb(c, verb) {
    c.title.querySelector(".tool-verb").textContent = verb;
  }

  function baseName(p) {
    const s = String(p || "").replace(/\/+$/, "");
    return s.slice(s.lastIndexOf("/") + 1) || s;
  }

  function shortDir(d) {
    const parts = String(d || "").split("/");
    return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : parts.join("/");
  }

  function dirName(p) {
    const s = String(p || "").replace(/\/+$/, "");
    const i = s.lastIndexOf("/");
    return i <= 0 ? "" : shortDir(s.slice(0, i));
  }

  function addDir(c, dir) {
    if (dir) {
      c.title.appendChild(el("span", "tool-dir", dir));
    }
  }

  function fileTitle(c, verb, path) {
    setTitle(c, verb, baseName(path), true, path);
    addDir(c, dirName(path));
  }

  function shortUrl(u) {
    const m = /^https?:\/\/(?:www\.)?([^/?#]+)([^?#]*)/.exec(String(u || ""));
    if (m == null) {
      return String(u || "");
    }
    const parts = m[2].split("/").filter(Boolean);
    return m[1] + (parts.length > 2 ? "/…/" + parts[parts.length - 1] : parts.length > 0 ? "/" + parts.join("/") : "");
  }

  function humanize(name) {
    const s = String(name || "").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  function syncExpandable(c) {
    c.root.classList.toggle("expandable", c.body.childNodes.length > 0);
  }

  function finish(c, result) {
    c.root.classList.remove("pending");
    if (result.err) {
      c.root.classList.add("error");
    }
    syncExpandable(c);
  }

  function outputBlock(text, title, err) {
    const block = md.codeBlock(text, "plaintext", { title: title });
    block.classList.add("output");
    if (err) {
      block.classList.add("err");
    }
    return block;
  }

  function resultText(result) {
    return String(result.text || "").replace(/<\/?tool_use_error>/g, "").replace(/^\s+|\s+$/g, "");
  }

  function diffFromPatch(hunks) {
    const wrap = el("div", "diff");
    let add = 0;
    let del = 0;
    hunks.forEach(function (h, idx) {
      if (idx > 0) {
        wrap.appendChild(el("div", "diff-line hunk", "⋯"));
      }
      let oldNo = h.oldStart || 0;
      let newNo = h.newStart || 0;
      const numbered = oldNo > 0 || newNo > 0;
      h.lines.forEach(function (line) {
        const sign = line.charAt(0);
        const row = el("div", "diff-line");
        const num = el("span", "ln");
        if (sign === "+") {
          row.classList.add("add");
          num.textContent = newNo;
          newNo += 1;
          add += 1;
        } else if (sign === "-") {
          row.classList.add("del");
          num.textContent = oldNo;
          oldNo += 1;
          del += 1;
        } else {
          num.textContent = newNo;
          oldNo += 1;
          newNo += 1;
        }
        if (!numbered) {
          num.textContent = "";
        }
        row.appendChild(num);
        row.appendChild(el("span", "sign", sign === "+" || sign === "-" ? sign : " "));
        row.appendChild(el("span", "code", line.slice(1)));
        wrap.appendChild(row);
      });
    });
    return { node: wrap, add: add, del: del };
  }

  // Line diff (LCS) of an edit's old and new string; big inputs fall back to all removed + all added.
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

  function diffFromStrings(oldStr, newStr) {
    return diffFromPatch([{ oldStart: 0, newStart: 0, lines: lineDiff(oldStr, newStr) }]);
  }

  // Diff of a pending Edit / MultiEdit / Write input, before the result brings the real patch.
  function inputDiff(name, input) {
    if (name === "Write") {
      return diffFromStrings("", input.content);
    }
    if (name === "MultiEdit" && Array.isArray(input.edits)) {
      return diffFromPatch(input.edits.map(function (e) {
        return { oldStart: 0, newStart: 0, lines: lineDiff(e.old_string, e.new_string) };
      }));
    }
    if (input.old_string != null || input.new_string != null) {
      return diffFromStrings(input.old_string, input.new_string);
    }
    return null;
  }

  function countBadge(meta, add, del) {
    meta.textContent = "";
    meta.dataset.add = add;
    meta.dataset.del = del;
    if (add > 0) {
      meta.appendChild(el("span", "plus", "+" + add));
    }
    if (del > 0) {
      meta.appendChild(el("span", "minus", "−" + del));
    }
  }

  const renderers = {};

  renderers.Bash = function (item, ctx) {
    const c = card("bash", "terminal");
    let block = null;
    let last = item.input || {};
    function head(input) {
      last = input;
      const cmd = String(input.command || "");
      if (c.root.classList.contains("in-group")) {
        setTitle(c, "", util.firstLine(cmd, 200), true, cmd);
        addDir(c, input.description || "");
      } else if (input.description) {
        setTitle(c, input.description, "", false, cmd);
      } else {
        setTitle(c, "Ran", util.firstLine(cmd, 200), true, cmd);
      }
      if (input.run_in_background) {
        c.meta.textContent = "in background";
        c.root.classList.add("background");
      }
      const fresh = md.codeBlock(cmd, "bash", { title: "Command" });
      if (block == null) {
        c.body.appendChild(fresh);
      } else {
        block.replaceWith(fresh);
      }
      block = fresh;
      syncExpandable(c);
    }
    head(last);
    return {
      root: c.root,
      update: head,
      regroup: function () {
        head(last);
      },
      result: function (r) {
        const ex = r.extra || {};
        const out = ex.stdout != null ? ex.stdout : resultText(r);
        if (out) {
          c.body.appendChild(outputBlock(out, "Output", r.err && !ex.stderr));
        }
        if (ex.stderr) {
          c.body.appendChild(outputBlock(ex.stderr, "Errors", true));
        }
        if (!out && !ex.stderr && r.text) {
          c.body.appendChild(outputBlock(r.text, "Output", r.err));
        }
        if (ex.interrupted) {
          c.meta.textContent = "interrupted";
          c.root.classList.add("interrupted");
        } else if (ex.background) {
          c.meta.textContent = "in background";
        } else if (r.err) {
          c.meta.textContent = ex.rc || "failed";
        }
        finish(c, r);
      },
    };
  };

  function editRenderer(item, ctx) {
    const input = item.input || {};
    const isWrite = item.name === "Write";
    const c = card("edit", isWrite ? "file" : "pencil");
    let shown = false;
    let done = false;
    function show(d) {
      c.body.textContent = "";
      c.body.appendChild(d.node);
      countBadge(c.meta, d.add, d.del);
      if (d.add + d.del <= 30 && !c.root.classList.contains("in-group")) {
        c.root.classList.add("open");
      }
      shown = true;
      syncExpandable(c);
    }
    // Before the result: the input as typed (a Write's content, an Edit's old → new diff), updated while streaming.
    function fromInput(input) {
      const path = util.shortPath(input.file_path || input.notebook_path, ctx.cwd);
      fileTitle(c, isWrite ? "Wrote" : "Edited", path);
      if (isWrite) {
        const content = String(input.content || "");
        c.body.textContent = "";
        c.body.appendChild(md.codeBlock(content, md.langFromPath(input.file_path), { title: path }));
        countBadge(c.meta, content.split("\n").length, 0);
      } else {
        const d = inputDiff(item.name, input);
        if (d != null) {
          show(d);
        }
      }
      syncExpandable(c);
    }
    fromInput(input);
    return {
      root: c.root,
      update: function (input) {
        if (!done) {
          fromInput(input);
        }
      },
      result: function (r) {
        done = true;
        const ex = r.extra || {};
        if (Array.isArray(ex.patch) && ex.patch.length > 0 && !isWrite) {
          show(diffFromPatch(ex.patch));
        }
        if (r.err) {
          c.body.appendChild(outputBlock(resultText(r), "Error", true));
          c.root.classList.add("open");
          setVerb(c, isWrite ? "Couldn't write" : "Couldn't edit");
        }
        if (isWrite && ex.created) {
          setVerb(c, "Created");
        }
        if (!shown && !isWrite && !r.err) {
          c.meta.textContent = "";
        }
        finish(c, r);
      },
    };
  }
  renderers.Edit = editRenderer;
  renderers.MultiEdit = editRenderer;
  renderers.Write = editRenderer;
  renderers.NotebookEdit = editRenderer;

  renderers.Read = function (item, ctx) {
    const input = item.input || {};
    const c = card("read", "file");
    c.root.classList.add("compact");
    let range = "";
    if (input.offset != null || input.limit != null) {
      const from = input.offset || 1;
      range = input.limit != null ? "lines " + from + "–" + (from + input.limit - 1) : "from line " + from;
    }
    fileTitle(c, "Read", util.shortPath(input.file_path, ctx.cwd));
    c.meta.textContent = range;
    return {
      root: c.root,
      result: function (r) {
        const ex = r.extra || {};
        if (ex.numLines != null && !range) {
          c.meta.textContent = plural(ex.numLines, "line", "lines");
        }
        if (r.err) {
          c.body.appendChild(outputBlock(resultText(r), "Error", true));
        } else if (r.text) {
          const text = resultText(r).replace(/^ *\d+\t/gm, "");
          c.body.appendChild(md.codeBlock(text, md.langFromPath(input.file_path), { title: util.shortPath(input.file_path, ctx.cwd) }));
        }
        finish(c, r);
      },
    };
  };

  function searchRenderer(item, ctx) {
    const input = item.input || {};
    const c = card("search", "search");
    c.root.classList.add("compact");
    const where = input.path ? util.shortPath(input.path, ctx.cwd) : "";
    const what = (input.pattern || input.query || "") + (input.glob ? " in " + input.glob : "");
    if (item.name === "LS") {
      setTitle(c, "Listed", where || ".", true, where);
    } else {
      const verb = item.name === "Glob" ? "Found files" : "Searched for";
      setTitle(c, verb, what, true, verb + " " + what + (where ? " in " + where : ""));
      addDir(c, shortDir(where));
    }
    return {
      root: c.root,
      result: function (r) {
        const ex = r.extra || {};
        if (ex.numFiles != null) {
          c.meta.textContent = plural(ex.numFiles, "file", "files");
        } else if (ex.numMatches != null) {
          c.meta.textContent = plural(ex.numMatches, "match", "matches");
        }
        if (r.text) {
          c.body.appendChild(outputBlock(resultText(r), "Results", r.err));
        }
        finish(c, r);
      },
    };
  }
  renderers.Grep = searchRenderer;
  renderers.Glob = searchRenderer;
  renderers.LS = searchRenderer;

  renderers.TodoWrite = function (item) {
    const todos = (item.input || {}).todos || [];
    const c = card("todo", "list", { open: true });
    const done = todos.filter(function (t) {
      return t.status === "completed";
    }).length;
    setTitle(c, "Tasks", "");
    c.meta.textContent = done + " of " + todos.length + " done";
    const list = el("ul", "todo-list");
    todos.forEach(function (t) {
      const li = el("li", "todo " + (t.status || "pending"));
      li.appendChild(util.icon(t.status === "completed" ? "checkSquare" : t.status === "in_progress" ? "circleDot" : "square"));
      li.appendChild(el("span", null, t.status === "in_progress" && t.activeForm ? t.activeForm : t.content));
      list.appendChild(li);
    });
    c.body.appendChild(list);
    syncExpandable(c);
    return {
      root: c.root,
      result: function (r) {
        finish(c, r);
      },
    };
  };

  function agentRenderer(item) {
    const input = item.input || {};
    const c = card("agent", "bot");
    const type = String(input.subagent_type || "");
    setTitle(c, type && type !== "general-purpose" ? humanize(type) + " agent" : "Agent", input.description || "", false, type);
    if (input.prompt) {
      const det = el("details", "agent-prompt");
      det.appendChild(el("summary", null, "Prompt"));
      det.appendChild(md.render(String(input.prompt)));
      c.body.appendChild(det);
    }
    syncExpandable(c);
    return {
      root: c.root,
      result: function (r) {
        const ex = r.extra || {};
        const bits = [];
        if (ex.isAsync) {
          bits.push("background");
        }
        if (ex.totalDurationMs) {
          bits.push(util.fmtDuration(ex.totalDurationMs));
        }
        c.meta.textContent = bits.join(" · ");
        if (ex.totalTokens) {
          c.meta.title = util.fmtTokens(ex.totalTokens) + " tokens";
        }
        if (r.text) {
          const res = el("div", "agent-result");
          res.appendChild(md.render(resultText(r)));
          c.body.appendChild(res);
        }
        finish(c, r);
      },
    };
  }
  renderers.Agent = agentRenderer;
  renderers.Task = agentRenderer;

  renderers.WebFetch = function (item) {
    const input = item.input || {};
    const c = card("web", "globe");
    c.root.classList.add("compact");
    if (item.name === "WebSearch") {
      setTitle(c, "Searched the web", input.query || "", false, input.query || "");
    } else {
      setTitle(c, "Read page", shortUrl(input.url), false, input.url || "");
    }
    return {
      root: c.root,
      result: function (r) {
        const ex = r.extra || {};
        if (ex.code && (ex.code < 200 || ex.code >= 300)) {
          c.meta.textContent = "HTTP " + ex.code;
        }
        if (r.text) {
          c.body.appendChild(md.render(resultText(r)));
        }
        finish(c, r);
      },
    };
  };
  renderers.WebSearch = renderers.WebFetch;

  renderers.AskUserQuestion = function (item) {
    const qs = (item.input || {}).questions || [];
    const c = card("question", "sparkle", { open: true });
    setTitle(c, "Question", qs.length === 1 ? qs[0].header || "" : qs.length + " questions");
    qs.forEach(function (q) {
      const box = el("div", "question");
      box.appendChild(el("div", "q-text", q.question));
      const opts = el("div", "q-options");
      (q.options || []).forEach(function (o) {
        const chip = el("span", "q-option", o.label);
        chip.title = o.description || "";
        chip.dataset.label = o.label;
        opts.appendChild(chip);
      });
      box.appendChild(opts);
      c.body.appendChild(box);
    });
    syncExpandable(c);
    return {
      root: c.root,
      result: function (r) {
        const answers = (r.extra || {}).answers || {};
        c.body.querySelectorAll(".question").forEach(function (box, i) {
          const q = qs[i] || {};
          const a = answers[q.question];
          if (a != null) {
            box.querySelectorAll(".q-option").forEach(function (chip) {
              if (String(a).split(", ").indexOf(chip.dataset.label) >= 0) {
                chip.classList.add("chosen");
              }
            });
            if (box.querySelector(".chosen") == null) {
              box.appendChild(el("div", "q-answer", String(a)));
            }
          }
        });
        if (Object.keys(answers).length === 0 && r.text) {
          c.body.appendChild(el("div", "q-answer", resultText(r)));
        }
        finish(c, r);
      },
    };
  };

  renderers.ExitPlanMode = function (item) {
    const c = card("plan", "list", { open: true });
    setTitle(c, "Plan", "");
    c.body.appendChild(md.render(String((item.input || {}).plan || "")));
    syncExpandable(c);
    return {
      root: c.root,
      result: function (r) {
        if (r.err) {
          c.meta.textContent = "not approved";
        }
        finish(c, r);
      },
    };
  };

  renderers.Skill = function (item) {
    const input = item.input || {};
    const c = card("skill", "sparkle");
    c.root.classList.add("compact");
    setTitle(c, "Used skill",(input.skill || input.command || "") + (input.args ? " " + input.args : ""), true);
    return {
      root: c.root,
      result: function (r) {
        finish(c, r);
      },
    };
  };

  function params(input) {
    const box = el("div", "tool-params");
    const list = el("dl", "kv");
    Object.keys(input).forEach(function (k) {
      const v = input[k];
      list.appendChild(el("dt", null, humanize(k)));
      list.appendChild(el("dd", typeof v === "string" ? null : "mono", typeof v === "string" ? v : JSON.stringify(v)));
    });
    box.appendChild(list);
    const raw = el("details", "raw-input");
    raw.appendChild(el("summary", null, "Raw input"));
    raw.appendChild(md.codeBlock(JSON.stringify(input, null, 2), "json", { title: "Input" }));
    box.appendChild(raw);
    return box;
  }

  function generic(item) {
    const input = item.input || {};
    const name = String(item.name || "tool");
    const c = card("generic", "wrench");
    let verb = humanize(name);
    let tip = name;
    if (name.indexOf("mcp__") === 0) {
      const parts = name.split("__");
      verb = humanize(parts.slice(2).join(" "));
      c.meta.textContent = humanize(parts[1].replace(/^plugin_/, "").replace(/^claude_ai_/, ""));
      tip = parts[1] + ": " + parts.slice(2).join("__");
    }
    const keys = Object.keys(input);
    const firstStr = keys.map(function (k) {
      return input[k];
    }).find(function (v) {
      return typeof v === "string" && v.length > 0;
    });
    setTitle(c, verb, firstStr ? util.firstLine(firstStr, 140) : "", false, tip);
    c.root.classList.add("compact");
    if (keys.length > 0) {
      c.body.appendChild(params(input));
    }
    syncExpandable(c);
    return {
      root: c.root,
      result: function (r) {
        if (r.text) {
          c.body.appendChild(outputBlock(resultText(r), "Result", r.err));
        }
        finish(c, r);
      },
    };
  }

  // Cards without their own `update` are rebuilt from the streamed input; the open and group state carries over.
  function render(item, ctx) {
    const fn = renderers[item.name] || generic;
    const view = fn(item, ctx);
    view.root.dataset.tool = item.name || "";
    view.root.dataset.tid = item.id || "";
    if (view.update == null) {
      view.update = function (input) {
        const fresh = fn({ id: item.id, name: item.name, ts: item.ts, input: input }, ctx);
        fresh.root.dataset.tool = item.name || "";
        fresh.root.dataset.tid = item.id || "";
        ["open", "in-group", "tg-hidden"].forEach(function (cls) {
          fresh.root.classList.toggle(cls, view.root.classList.contains(cls));
        });
        view.root.replaceWith(fresh.root);
        view.root = fresh.root;
        view.result = fresh.result;
      };
    }
    return view;
  }

  const GROUP_ICON = { explore: "search", bash: "terminal", edit: "pencil", web: "globe" };
  const GROUP_SHOWN = 6;

  // Consecutive calls of one run kind (CC.Store.runKind): one call keeps its own card, from the second on the cards
  // become rows of a group card. `label(items)` titles the group.
  function Group(kind, view, item, label) {
    this.kind = kind;
    this.views = [view];
    this.items = [item];
    this.label = label;
    this.c = null;
    this.more = null;
    this.all = false;
  }

  Group.prototype.el = function () {
    return this.c != null ? this.c.root : this.views[0].root;
  };

  Group.prototype.add = function (view, item) {
    if (this.c == null) {
      this.build();
    }
    this.views.push(view);
    this.items.push(item);
    this.adopt(view);
    this.c.body.appendChild(view.root);
    this.refresh();
  };

  Group.prototype.build = function () {
    const self = this;
    const c = card("group", GROUP_ICON[this.kind] || "wrench", { open: true });
    c.root.classList.add("tool-group-" + this.kind, "expandable");
    c.root._group = this;
    c.root._reveal = function () {
      c.root.classList.add("open");
      if (!self.all) {
        self.all = true;
        self.refresh();
      }
    };
    this.more = el("button", "tg-more hidden");
    this.more.type = "button";
    this.more.addEventListener("click", function () {
      self.all = true;
      self.refresh();
    });
    c.body.appendChild(this.more);
    const first = this.views[0];
    first.root.replaceWith(c.root);
    this.c = c;
    this.adopt(first);
    c.body.appendChild(first.root);
  };

  Group.prototype.adopt = function (view) {
    view.root.classList.add("in-group");
    if (!view.root.classList.contains("error")) {
      view.root.classList.remove("open");
    }
    if (view.regroup != null) {
      view.regroup();
    }
  };

  // Header from the rows: label, +/− of edits, spinner while any row runs, a dot when any failed; only the last
  // GROUP_SHOWN rows of a long group show until "Show earlier".
  Group.prototype.refresh = function () {
    const c = this.c;
    if (c == null) {
      return;
    }
    const n = this.views.length;
    const hide = this.all || n <= GROUP_SHOWN + 2 ? 0 : n - GROUP_SHOWN;
    let pending = false;
    let failed = 0;
    let add = 0;
    let del = 0;
    this.views.forEach(function (v, i) {
      const r = v.root;
      const m = r.querySelector(":scope > .tool-head > .tool-meta");
      pending = pending || r.classList.contains("pending");
      failed += r.classList.contains("error") ? 1 : 0;
      add += Number(m.dataset.add || 0);
      del += Number(m.dataset.del || 0);
      r.classList.toggle("tg-hidden", i < hide);
    });
    setTitle(c, this.label(this.items), "");
    c.root.classList.toggle("pending", pending);
    c.root.classList.toggle("has-error", failed > 0);
    c.head.title = failed > 0 ? plural(failed, "call", "calls") + " failed" : "";
    if (this.kind === "edit") {
      countBadge(c.meta, add, del);
    } else {
      c.meta.textContent = failed > 0 ? failed + " failed" : "";
    }
    this.more.textContent = hide > 0 ? "Show " + plural(hide, "earlier call", "earlier calls") : "";
    this.more.classList.toggle("hidden", hide === 0);
  };

  return { render: render, renderers: renderers, inputDiff: inputDiff, Group: Group };
})();
