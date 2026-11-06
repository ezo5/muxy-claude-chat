// flowEnd's own part: the task card and the running turn's one live line, by today's priorities: running tool with target and elapsed,
// tool input still streaming, thinking, background agents, compaction estimate. A pending question or permission has C3's card instead.
CC.LiveLine = (function () {
  const util = CC.util;
  const el = util.el;
  const TICK_MS = 1000;
  const SOON_MS = 150;

  function sinceOf(ts) {
    const t = CC.conv.tsMs(ts);
    return isNaN(t) ? null : t;
  }

  function longestString(input) {
    let best = "";
    Object.keys(input || {}).forEach(function (k) {
      const v = input[k];
      if (typeof v === "string" && v.length > best.length) {
        best = v;
      }
    });
    return best;
  }

  // Pure: what the line says for the store's state. ctx: {busy, compacting, compactAt, contextTokens, startedAt, background: [names]}.
  function info(store, ctx) {
    const a = ctx.busy ? store.activity() : null;
    if (a != null && a.kind !== "thinking") {
      const it = a.item;
      const l = CC.toolDetail.label(it, null, { cwd: "" });
      const out = { label: it.name, target: CC.toolDetail.target(it) };
      if (a.kind === "tool") {
        const verb = [l.verb, l.name || l.text].filter(Boolean).join(" ");
        out.label = verb || l.text || it.name;
        out.target = "";
        out.since = sinceOf(it.ts);
        out.tail = it.name === "Bash" ? String((it.input || {}).command || "") : "";
      } else {
        out.label = "Preparing " + it.name;
        // A command stays out of the line, as for one that runs. It can be long, and it can hold a password.
        if (it.name === "Bash") {
          out.target = "";
        }
        out.extra = it.inputChars > 0 ? (it.inputChars >= 1000 ? Math.round(it.inputChars / 1000) + "k" : it.inputChars) + " chars" : "";
        out.tail = longestString(it.input);
      }
      if (out.tail.length <= 120 && out.tail.indexOf("\n") < 0) {
        out.tail = "";
      }
      return out;
    }
    if (a != null) {
      return { label: "Thinking", since: sinceOf(a.item.ts), tail: a.item.text };
    }
    const bg = ctx.background || [];
    if (bg.length > 0) {
      return { label: bg.length === 1 ? "Waiting for a background task" : "Waiting for " + bg.length + " background tasks", target: bg.join(", "), tail: bg.join("\n") };
    }
    if (ctx.busy && ctx.compacting) {
      // No progress is reported; the estimate grows with the context and slows down near its end.
      const eta = Math.min(180, Math.max(30, 20 + (ctx.contextTokens || 0) / 4000)) * 1000;
      return { label: "Compacting", since: ctx.compactAt, eta: eta };
    }
    return ctx.busy ? { label: "Working", since: ctx.startedAt || null } : null;
  }

  function taskRow(t) {
    const row = el("li", "cv-task is-" + (t.status || "pending"));
    const mark = el("span", "cv-task-mark");
    if (t.status === "in_progress") {
      // Still, not a spinner: the live line has the one working spinner, and this stays while Claude waits for an answer.
      mark.appendChild(el("span", "cv-task-now"));
    } else if (t.status === "completed") {
      mark.appendChild(CC.ui.icon("check", 14));
    } else {
      mark.appendChild(CC.ui.icon("todoRing", 14));
    }
    row.append(mark, el("span", "cv-task-text", t.status === "in_progress" && t.activeForm ? t.activeForm : t.content));
    return row;
  }

  // The task list as a card at the end of the flow, gone once all are done and Claude is free. The rail's Tasks card keeps showing it.
  function taskCard() {
    const box = el("div", "cv-tasks");
    box.hidden = true;
    let collapsed = false;
    let shown = "";
    let last = { todos: [], busy: false };

    function render(todos, busy) {
      last = { todos: todos, busy: busy };
      const done = todos.filter(function (t) {
        return t.status === "completed";
      }).length;
      const show = todos.length > 0 && (busy || done < todos.length);
      const key = show ? JSON.stringify([todos, collapsed]) : "";
      if (key === shown) {
        return;
      }
      shown = key;
      box.replaceChildren();
      box.hidden = !show;
      if (!show) {
        return;
      }
      const head = el("button", "cv-tasks-head" + (collapsed ? "" : " is-open"));
      head.type = "button";
      head.setAttribute("aria-expanded", String(!collapsed));
      head.title = collapsed ? "Show tasks" : "Hide tasks";
      const chev = el("span", "cc-chev");
      chev.appendChild(CC.ui.icon("chevron", 12));
      head.append(chev, el("span", "cv-tasks-title", "Tasks"), el("span", "cv-tasks-count", done + "/" + todos.length));
      const current = todos.find(function (t) {
        return t.status === "in_progress";
      });
      if (collapsed && current != null) {
        head.appendChild(el("span", "cv-tasks-current", current.activeForm || current.content));
      }
      head.addEventListener("click", function () {
        collapsed = !collapsed;
        render(last.todos, last.busy);
      });
      box.appendChild(head);
      if (!collapsed) {
        const list = el("ul", "cv-tasks-list");
        todos.forEach(function (t) {
          list.appendChild(taskRow(t));
        });
        box.appendChild(list);
      }
    }

    return { el: box, render: render };
  }

  // env: {store, runtime, chatId}. The flow's size observer keeps the end in view when the line grows.
  function mount(host, env) {
    const store = env.store;
    const tasks = taskCard();
    const row = el("div", "cv-live");
    row.hidden = true;
    const head = el("button", "cv-live-head");
    head.type = "button";
    const label = el("span", "cv-live-label");
    const target = el("span", "cv-live-target");
    const extra = el("span", "cv-live-extra");
    const time = el("span", "cv-live-time");
    const chev = el("span", "cc-chev");
    chev.appendChild(CC.ui.icon("chevron", 12));
    // The one working spinner, on whatever the line says now (tool, thinking, compacting, "Working" before the first tool). It hangs in the
    // column's left padding, so the text keeps its edge with and without it, in line with the finished rows above.
    const working = CC.ui.spinner();
    working.classList.add("cv-live-spin");
    working.setAttribute("aria-hidden", "true");
    working.hidden = true;
    head.append(working, label, target, extra, time, chev);
    const bar = el("div", "cv-live-bar");
    bar.hidden = true;
    bar.appendChild(el("i"));
    const tail = el("pre", "cv-live-tail");
    row.append(head, bar, tail);
    host.append(tasks.el, row);
    head.addEventListener("click", function () {
      if (row.classList.contains("has-tail")) {
        row.classList.toggle("is-open");
      }
    });

    let compactAt = 0;
    let soon = 0;

    function background() {
      const r = CC.Chats != null && env.chatId != null && CC.Chats.get != null ? CC.Chats.get(env.chatId) : null;
      if (store.status !== "idle" || r == null || !Array.isArray(r.running)) {
        return [];
      }
      return r.running.filter(function (a) {
        return a.status == null || a.status === "running";
      }).filter(function (a) {
        return a.kind !== "bash";
      }).map(function (a) {
        return typeof a === "string" ? a : a.description || a.type || "agent";
      });
    }

    function paint() {
      if (document.hidden) {
        return;
      }
      const m = store.meta || {};
      const pending = (store.pending || []).length > 0;
      const busy = store.status === "busy" && !pending;
      const compacting = busy && m.activity === "compacting";
      if (compacting && compactAt === 0) {
        compactAt = Date.now();
      } else if (!compacting) {
        compactAt = 0;
      }
      tasks.render(store.todos() || [], store.status === "busy");
      const line = pending ? null : info(store, { busy: busy, compacting: compacting, compactAt: compactAt, contextTokens: m.contextTokens, startedAt: m.turn != null ? m.turn.startedAt : null, background: background() });
      row.hidden = line == null;
      // Background tasks can outlast the turn: the line stays for them, the spinner doesn't.
      working.hidden = !busy;
      if (line == null) {
        row.classList.remove("is-open");
      } else {
        label.textContent = line.label;
        target.textContent = line.target || "";
        target.title = line.target || "";
        extra.textContent = line.extra || "";
        const ms = line.since != null ? Date.now() - line.since : 0;
        time.textContent = line.since != null && ms >= 1000 ? util.fmtDuration(ms) + (line.eta ? " of ~" + util.fmtDuration(line.eta) : "") : "";
        bar.hidden = line.eta == null;
        if (line.eta != null) {
          const p = ms < line.eta * 0.8 ? ms / line.eta : 0.8 + 0.17 * (1 - Math.exp(-(ms - line.eta * 0.8) / line.eta));
          bar.firstChild.style.width = (p * 100).toFixed(1) + "%";
        }
        const text = line.tail || "";
        row.classList.toggle("has-tail", text !== "");
        if (text === "") {
          row.classList.remove("is-open");
        }
        const shown = text.length > 4000 ? "…" + text.slice(-4000) : text;
        if (tail.textContent !== shown) {
          const end = tail.scrollHeight - tail.scrollTop - tail.clientHeight < 24;
          tail.textContent = shown;
          if (end) {
            tail.scrollTop = tail.scrollHeight;
          }
        }
      }
    }

    function later() {
      if (soon === 0) {
        soon = setTimeout(function () {
          soon = 0;
          paint();
        }, SOON_MS);
      }
    }

    const offs = ["items:add", "items:update", "items:prepend", "reset"].map(function (name) {
      return store.on(name, later);
    });
    offs.push(store.on("state", paint));
    const ticker = setInterval(function () {
      if (store.status === "busy" || !row.hidden) {
        paint();
      }
    }, TICK_MS);
    if (CC.Chats != null && CC.Chats.on != null) {
      offs.push(CC.Chats.on(later));
    }
    paint();

    return {
      paint: paint,
      unmount: function () {
        clearInterval(ticker);
        clearTimeout(soon);
        offs.forEach(function (off) {
          if (off != null) {
            off();
          }
        });
        host.replaceChildren();
      },
    };
  }

  return { mount: mount, info: info };
})();
