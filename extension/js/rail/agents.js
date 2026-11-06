// The Agents card: subagents with what they spawned, and background commands, as rows of the op `agents`. A subagent opens its read-only
// pane; a background command folds out its output tail and a Stop.
CC.RailAgents = (function () {
  const util = CC.util;
  const el = util.el;
  const TICK_MS = 1000;
  const STATES = { running: "running", done: "done", error: "failed", stopped: "stopped" };

  function elapsed(a) {
    if (a.ms != null && a.status !== "running") {
      return a.ms;
    }
    const start = Date.parse(a.startTs);
    const end = a.status === "running" || a.endTs == null ? Date.now() : Date.parse(a.endTs);
    return isNaN(start) ? null : Math.max(0, end - start);
  }

  // Splits the rows into what's alive and what's finished, newest first, each row followed by what it spawned.
  // A running row keeps everything it spawned, finished or not. A finished row goes to `done` with its finished children; a running child
  // leaves it and stands on its own. Rows are {a, indent, depth}: indent is where it's drawn, depth how far down the tree it really is.
  function sections(list) {
    const ids = new Set(list.map(function (a) {
      return a.id;
    }));
    const kids = new Map();
    list.forEach(function (a) {
      const k = ids.has(a.parent) ? a.parent : "";
      if (!kids.has(k)) {
        kids.set(k, []);
      }
      kids.get(k).push(a);
    });
    const childrenOf = function (id) {
      return (kids.get(id) || []).slice().reverse();
    };
    const live = [];
    const done = [];
    function liveTree(a, indent, depth) {
      live.push({ a: a, indent: indent, depth: depth });
      childrenOf(a.id).forEach(function (c) {
        liveTree(c, indent + 1, depth + 1);
      });
    }
    function sort(a, indent, depth) {
      if (a.status === "running") {
        liveTree(a, 0, depth);
        return;
      }
      done.push({ a: a, indent: indent, depth: depth });
      childrenOf(a.id).forEach(function (c) {
        sort(c, indent + 1, depth + 1);
      });
    }
    childrenOf("").forEach(function (a) {
      sort(a, 0, 0);
    });
    return { live: live, done: done };
  }

  // Whether `Done · N` is open: one answer for every chat, kept in kv `ui/agentsDone`.
  const doneFold = {
    open: false,
    touched: false,
    loaded: null,
    handlers: new Set(),
    load: function () {
      const self = this;
      if (this.loaded == null) {
        this.loaded = CC.Servers.appKv().get("ui", "agentsDone").then(function (v) {
          if (!self.touched) {
            self.open = v === true;
            self.notify();
          }
        }, function (e) {
          console.warn("agents fold state not read", e && e.message);
        });
      }
    },
    toggle: function () {
      this.touched = true;
      this.open = !this.open;
      this.notify();
      CC.Servers.appKv().set("ui", "agentsDone", this.open).catch(function (e) {
        console.warn("agents fold state not saved", e && e.message);
      });
    },
    notify: function () {
      this.handlers.forEach(function (fn) {
        fn();
      });
    },
  };

  function markOf(a) {
    if (a.kind === "bash") {
      const icon = el("span", "cc-agent-icon is-" + a.status);
      icon.appendChild(CC.ui.icon("terminal", 12));
      return icon;
    }
    if (a.status === "running") {
      return CC.ui.stateMark("busy");
    }
    if (a.status === "error") {
      return CC.ui.stateMark("error");
    }
    const icon = el("span", "cc-agent-icon is-" + a.status);
    icon.appendChild(CC.ui.icon(a.status === "done" ? "check" : "x", 12));
    return icon;
  }

  function subLine(a, depth) {
    const bash = a.kind === "bash";
    return [STATES[a.status] || a.status, bash ? "background command" : a.type, !bash && a.background ? "in background" : null, !bash && depth > 0 ? "nested" : null]
      .filter(Boolean).join(" · ");
  }

  // At most one agent pane per chat: Shell.open knows a pane by kind and chat, not by which subagent it follows.
  function openPane(a, ctx, model) {
    const file = a.file || a.inline || null;
    if (file == null) {
      CC.ui.toast("No transcript for this agent yet");
      return;
    }
    const panes = ctx.shell.panes().filter(function (p) {
      return p.kind === "agent" && p.chatId === ctx.chatId;
    });
    if (panes.length > 0 && panes[0].params != null && panes[0].params.file === file) {
      ctx.shell.focus(panes[0].id);
      return;
    }
    if (panes.length > 0) {
      ctx.shell.close(panes[0].id);
    }
    ctx.shell.open({ kind: "agent", chatId: ctx.chatId, params: { file: file, title: a.description || a.type || "Agent", daemon: model.daemon(), cwd: model.cwd() } }, { beside: true });
  }

  function stopTask(a, model, button) {
    button.disabled = true;
    button.textContent = "Stopping…";
    model.control("stop_task", { task_id: a.taskId || a.agentId }).then(function () {
      model.soon();
    }, function (e) {
      CC.ui.toast("Stop failed: " + e.message, { level: "error" });
      button.disabled = false;
      button.textContent = "Stop";
    });
  }

  function makeRow(ctx, model) {
    const r = { data: null, depth: 0, open: false, root: el("div", "cc-agent") };
    r.line = el("button", "cc-agent-line");
    r.line.type = "button";
    r.mark = el("span", "cc-mark");
    const body = el("span", "cc-agent-body");
    const top = el("span", "cc-agent-top");
    r.name = el("span", "cc-agent-name");
    r.time = el("span", "cc-agent-time");
    top.appendChild(r.name);
    top.appendChild(r.time);
    r.sub = el("span", "cc-agent-sub");
    r.last = el("span", "cc-agent-last");
    body.appendChild(top);
    body.appendChild(r.sub);
    body.appendChild(r.last);
    r.line.appendChild(r.mark);
    r.line.appendChild(body);
    r.root.appendChild(r.line);
    r.detail = el("div", "cc-agent-detail");
    r.tail = el("pre", "cc-agent-tail");
    r.stop = CC.ui.button({
      label: "Stop",
      onClick: function () {
        stopTask(r.data, model, r.stop);
      },
    });
    r.detail.appendChild(r.tail);
    r.detail.appendChild(r.stop);
    r.detail.hidden = true;
    r.root.appendChild(r.detail);
    r.line.addEventListener("click", function () {
      if (r.data.kind === "bash") {
        r.open = !r.open;
        r.detail.hidden = !r.open;
        r.line.setAttribute("aria-expanded", String(r.open));
      } else {
        openPane(r.data, ctx, model);
      }
    });
    return r;
  }

  function paintRow(r, row, model) {
    const a = row.a;
    const statusChanged = r.data == null || r.data.status !== a.status || r.data.kind !== a.kind;
    r.data = a;
    r.depth = row.depth;
    r.root.style.setProperty("--depth", row.indent);
    const bash = a.kind === "bash";
    r.root.dataset.kind = bash ? "bash" : "agent";
    r.root.dataset.status = a.status;
    r.line.title = bash ? a.command || "" : a.file != null || a.inline != null ? "Open the transcript" : "No transcript for this agent yet";
    if (statusChanged) {
      const mark = markOf(a);
      r.mark.replaceWith(mark);
      r.mark = mark;
    }
    r.name.textContent = a.description || a.type || a.command || "Agent";
    r.time.textContent = util.fmtDuration(elapsed(a));
    r.sub.textContent = subLine(a, row.depth);
    r.last.textContent = a.last || "";
    r.last.title = a.last || "";
    r.last.hidden = !a.last;
    if (bash) {
      const stuckToEnd = r.tail.scrollTop + r.tail.clientHeight >= r.tail.scrollHeight - 4;
      r.tail.textContent = a.tail || "(no output yet)";
      if (stuckToEnd) {
        r.tail.scrollTop = r.tail.scrollHeight;
      }
      r.stop.hidden = a.status !== "running" || !model.inChatMode() || (a.taskId == null && a.agentId == null);
    }
  }

  // Moving a node resets its scroll position, so rows move only when out of place.
  function place(list, node, index) {
    if (list.children[index] !== node) {
      list.insertBefore(node, list.children[index] || null);
    }
  }

  function makeFold() {
    const line = el("button", "cc-agents-fold");
    line.type = "button";
    const chev = el("span", "cc-chev");
    chev.appendChild(CC.ui.icon("chevron", 12));
    line.appendChild(chev);
    line.label = el("span", "cc-agents-fold-label");
    line.appendChild(line.label);
    line.addEventListener("click", function () {
      doneFold.toggle();
    });
    return line;
  }

  function mount(host, ctx) {
    const model = CC.RailData.of(ctx.runtime);
    const release = model.acquire();
    const list = el("div", "cc-agents");
    const empty = el("div", "cc-rail-note", "Subagents and background commands Claude starts show up here.");
    host.appendChild(empty);
    host.appendChild(list);
    const rows = new Map();
    const fold = makeFold();

    function paint() {
      const parts = sections(model.rows);
      const all = parts.live.concat(parts.done);
      empty.hidden = all.length > 0;
      const seen = new Set();
      all.forEach(function (row) {
        seen.add(row.a.id);
        if (!rows.has(row.a.id)) {
          rows.set(row.a.id, makeRow(ctx, model));
        }
        paintRow(rows.get(row.a.id), row, model);
      });
      rows.forEach(function (r, id) {
        if (!seen.has(id)) {
          r.root.remove();
          rows.delete(id);
        }
      });
      const rootOf = function (row) {
        return rows.get(row.a.id).root;
      };
      const shown = parts.live.map(rootOf);
      if (parts.done.length > 0) {
        fold.label.textContent = "Done · " + parts.done.filter(function (row) {
          return row.indent === 0;
        }).length;
        fold.classList.toggle("is-open", doneFold.open);
        fold.setAttribute("aria-expanded", String(doneFold.open));
        shown.push(fold);
        if (doneFold.open) {
          parts.done.forEach(function (row) {
            shown.push(rootOf(row));
          });
        }
      }
      // Folded rows stay built, so a command's open tail is still open when they come back.
      Array.from(list.children).forEach(function (node) {
        if (shown.indexOf(node) < 0) {
          node.remove();
        }
      });
      shown.forEach(function (node, index) {
        place(list, node, index);
      });
    }

    const cardEl = host.closest(".cc-card");
    model.cardOpen = function () {
      return cardEl == null || cardEl.isOpen == null || cardEl.isOpen();
    };
    model.kick(0, true);
    const off = model.on(paint);
    doneFold.handlers.add(paint);
    doneFold.load();
    const tick = setInterval(function () {
      rows.forEach(function (r) {
        if (r.data != null && r.data.status === "running") {
          r.time.textContent = util.fmtDuration(elapsed(r.data));
        }
      });
    }, TICK_MS);
    paint();

    return {
      unmount: function () {
        clearInterval(tick);
        off();
        doneFold.handlers.delete(paint);
        model.cardOpen = null;
        release();
      },
    };
  }

  function statusOf(model) {
    const running = model.runningCount();
    if (running > 0) {
      return running + " running";
    }
    return model.rows.length > 0 ? String(model.rows.length) : null;
  }

  return { mount: mount, statusOf: statusOf };
})();
