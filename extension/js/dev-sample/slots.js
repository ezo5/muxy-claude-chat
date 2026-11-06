// Sample content for every chat slot. Each slot works only inside the `el` it was given and keeps its state on the runtime.
CC.devSample.registerSlots = function () {
  const el = CC.util.el;
  const FALLBACK = { fallback: true };

  function lineEl(sign, n, text) {
    let cls = "sm-ln";
    if (sign === "+") {
      cls += " sm-ln-add";
    } else if (sign === "-") {
      cls += " sm-ln-del";
    }
    const row = el("div", cls);
    row.appendChild(el("i", null, String(n)));
    row.appendChild(el("span", null, text));
    return row;
  }
  CC.devSample.lineEl = lineEl;

  function detailOf(r) {
    if (r.code == null && r.diff == null) {
      return null;
    }
    const box = el("div", "sm-detail");
    box.appendChild(el("div", "sm-path", r.path));
    const viewer = el("div", "sm-viewer");
    if (r.code != null) {
      r.code.forEach(function (t, i) {
        viewer.appendChild(lineEl(" ", r.from + i, t));
      });
    } else {
      r.diff.forEach(function (l) {
        viewer.appendChild(lineEl(l[0], l[1], l[2]));
      });
    }
    box.appendChild(viewer);
    return box;
  }

  function logRow(ui, key, r) {
    const item = el("div", "sm-log-item");
    const detail = detailOf(r);
    const row = el("button", "sm-log-row");
    row.type = "button";
    const label = el("span", "sm-label");
    label.appendChild(document.createTextNode(r.label));
    if (r.name != null) {
      label.appendChild(document.createTextNode(" "));
      label.appendChild(el("b", null, r.name));
    }
    row.appendChild(label);
    if (r.add != null) {
      row.appendChild(CC.ui.numbers(r.add, r.del));
    }
    if (r.failed) {
      row.appendChild(el("span", "sm-failed", "Failed"));
    }
    item.appendChild(row);
    if (detail == null) {
      row.disabled = true;
      row.classList.add("sm-log-plain");
      return item;
    }
    const chev = el("span", "cc-chev");
    chev.appendChild(CC.ui.icon("chevron", 12));
    row.appendChild(chev);
    function apply() {
      const open = ui.open.has(key);
      item.classList.toggle("sm-is-open", open);
      row.setAttribute("aria-expanded", String(open));
      detail.hidden = !open;
    }
    row.addEventListener("click", function () {
      if (ui.open.has(key)) {
        ui.open.delete(key);
      } else {
        ui.open.add(key);
      }
      apply();
    });
    item.appendChild(detail);
    apply();
    return item;
  }

  function workEl(ui, b, i) {
    const key = "w" + i;
    return CC.ui.disclosure({
      label: b.summary,
      numbers: b.add != null ? [b.add, b.del] : null,
      open: ui.open.has(key),
      onToggle: function (open) {
        if (open) {
          ui.open.add(key);
        } else {
          ui.open.delete(key);
        }
      },
      body: function (host) {
        const log = el("div", "sm-log");
        b.rows.forEach(function (r, j) {
          log.appendChild(logRow(ui, key + ":" + j, r));
        });
        host.appendChild(log);
      },
    });
  }

  function promptEl(b) {
    const wrap = el("div", "sm-prompt-wrap");
    wrap.appendChild(el("div", "sm-prompt", b.text));
    const acts = el("div", "sm-prompt-acts");
    acts.appendChild(el("span", null, b.time || "Just now"));
    acts.appendChild(CC.ui.iconButton({ icon: "copy", label: "Copy", size: 14 }));
    acts.appendChild(CC.ui.iconButton({ icon: "rewind", label: "Rewind to here", size: 14 }));
    acts.appendChild(CC.ui.iconButton({ icon: "fork", label: "Fork from here", size: 14 }));
    wrap.appendChild(acts);
    return wrap;
  }

  function filesEl(b, ctx) {
    const box = el("div", "sm-files");
    const head = el("div", "sm-files-head");
    head.appendChild(el("span", null, b.title));
    head.appendChild(CC.ui.numbers(b.add, b.del));
    box.appendChild(head);
    b.rows.forEach(function (r) {
      const row = el("button", "sm-file");
      row.type = "button";
      row.appendChild(el("span", "sm-label", r[0]));
      row.appendChild(CC.ui.numbers(r[1], r[2]));
      row.addEventListener("click", function () {
        ctx.shell.open({ kind: "review", chatId: ctx.chatId }, { beside: true });
      });
      box.appendChild(row);
    });
    return box;
  }

  function answeredEl(b) {
    const box = el("div", "sm-answered", b.q);
    box.appendChild(el("span", null, b.a));
    return box;
  }

  function askEl(b, ctx) {
    const box = el("div", "sm-ask");
    box.appendChild(el("div", "sm-ask-q", b.q));
    if (b.command != null) {
      box.appendChild(el("pre", null, b.command));
    }
    b.options.forEach(function (o, n) {
      const opt = el("button", "sm-opt");
      opt.type = "button";
      opt.appendChild(el("i", null, String(n + 1)));
      const text = el("span", null, o.title);
      if (o.sub != null) {
        text.appendChild(el("small", null, o.sub));
      }
      opt.appendChild(text);
      opt.addEventListener("click", function () {
        ctx.runtime.respond(b.id, o.key);
      });
      box.appendChild(opt);
    });
    return box;
  }

  function flowBlock(b, i, ctx) {
    const ui = ctx.runtime.ui;
    if (b.k === "prompt") {
      return promptEl(b);
    }
    if (b.k === "text") {
      const text = el("div", "sm-text");
      text.innerHTML = b.html;
      return text;
    }
    if (b.k === "work") {
      return workEl(ui, b, i);
    }
    if (b.k === "files") {
      return filesEl(b, ctx);
    }
    if (b.k === "answered") {
      return answeredEl(b);
    }
    if (b.k === "end") {
      return el("div", "sm-turn-end", b.text);
    }
    return null;
  }

  function follow(host) {
    const scroller = host.closest(".cc-chat-scroll");
    if (scroller != null) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }

  function watched(ctx, draw) {
    draw();
    return { unmount: ctx.runtime.on("change", draw) };
  }

  CC.ChatPane.slot("flow", function (host, ctx) {
    return watched(ctx, function () {
      host.replaceChildren();
      ctx.runtime.store.blocks.forEach(function (b, i) {
        const node = flowBlock(b, i, ctx);
        if (node != null) {
          host.appendChild(node);
        }
      });
    });
  }, FALLBACK);

  CC.ChatPane.slot("flowEnd", function (host, ctx) {
    let timer = null;
    function tick(secs, since) {
      secs.textContent = Math.round((Date.now() - since) / 1000) + " s";
    }
    const drawn = watched(ctx, function () {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
      host.replaceChildren();
      ctx.runtime.store.blocks.forEach(function (b) {
        if (b.k === "permission" || b.k === "question") {
          host.appendChild(askEl(b, ctx));
        }
        if (b.k === "live") {
          if (b.since == null) {
            b.since = Date.now() - (b.secs || 0) * 1000;
          }
          const live = el("div", "sm-live");
          live.appendChild(el("span", "cc-spin"));
          live.appendChild(el("span", null, b.text));
          const secs = el("span", "sm-secs");
          live.appendChild(secs);
          tick(secs, b.since);
          timer = setInterval(function () {
            tick(secs, b.since);
          }, 1000);
          host.appendChild(live);
        }
      });
      follow(host);
    });
    return {
      unmount: function () {
        clearInterval(timer);
        drawn.unmount();
      },
    };
  }, FALLBACK);

  function tasksEl(block) {
    const box = el("div", "sm-tasks");
    block.items.forEach(function (t) {
      const row = el("div", "sm-task" + (t[0] === "done" ? " is-done" : ""));
      if (t[0] === "done") {
        row.appendChild(CC.ui.icon("check", 12));
      } else if (t[0] === "run") {
        row.appendChild(el("span", "cc-spin"));
      } else {
        row.appendChild(el("span", "sm-pending"));
      }
      row.appendChild(el("span", null, t[1]));
      box.appendChild(row);
    });
    return box;
  }

  CC.ChatPane.slot("aboveComposer", function (host, ctx) {
    return watched(ctx, function () {
      host.replaceChildren();
      const c = ctx.runtime.chat;
      const tasks = c.blocks.find(function (b) {
        return b.k === "tasks";
      });
      if (tasks != null) {
        host.appendChild(tasksEl(tasks));
      }
      if (c.changes[2] === 0) {
        return;
      }
      const row = el("div", "sm-git-row");
      const name = el("span", "sm-grow", c.branch + " ");
      name.appendChild(CC.ui.numbers(c.changes[0], c.changes[1]));
      row.appendChild(name);
      row.appendChild(CC.ui.chip({
        label: "Review changes",
        onClick: function () {
          ctx.shell.open({ kind: "review", chatId: ctx.chatId }, { beside: true });
        },
      }));
      host.appendChild(row);
    });
  }, FALLBACK);

  CC.ChatPane.slot("composer", function (host, ctx) {
    const rt = ctx.runtime;
    const field = el("div", "sm-field");
    const area = el("textarea");
    area.rows = 1;
    area.setAttribute("aria-label", "Message");
    area.value = rt.ui.draft;
    const send = CC.ui.iconButton({ icon: "send", label: "Send" });
    send.classList.add("sm-send");

    function submit() {
      if (rt.status() === "busy") {
        return;
      }
      const text = area.value;
      area.value = "";
      rt.ui.draft = "";
      fit();
      rt.send({ text: text });
    }
    function fit() {
      area.style.height = "auto";
      area.style.height = Math.min(area.scrollHeight, 160) + "px";
    }
    function sync() {
      const busy = rt.status() === "busy";
      area.placeholder = busy ? "Queue a message" : "Message Claude, / for commands";
      send.replaceChildren(CC.ui.icon(busy ? "stop" : "send"));
      send.title = busy ? "Stop" : "Send";
      send.setAttribute("aria-label", send.title);
    }
    area.addEventListener("input", function () {
      rt.ui.draft = area.value;
      fit();
    });
    area.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    send.addEventListener("click", submit);
    field.appendChild(area);
    field.appendChild(send);
    host.appendChild(field);
    sync();
    return { unmount: rt.on("change", sync) };
  }, FALLBACK);

  CC.ChatPane.slot("belowComposer", function (host, ctx) {
    const c = ctx.runtime.chat;
    const row = el("div", "sm-under");
    row.appendChild(el("button", null, c.mode));
    row.appendChild(el("span", "sm-grow"));
    row.appendChild(el("button", null, c.model));
    row.appendChild(el("button", null, c.effort));
    host.appendChild(row);
    return null;
  }, FALLBACK);

  CC.ChatPane.slot("belowComposer", function (host, ctx) {
    const c = ctx.runtime.chat;
    const ring = CC.ui.ring(c.ctx[0] / c.ctx[1] * 100);
    ring.title = c.ctx[0] + "k of " + c.ctx[1] + "k used";
    host.appendChild(ring);
    return null;
  }, { fallback: true, order: 10 });

  // Find bar: floats over the flow, one per chat, opened with mod+f in the focused pane.
  CC.ChatPane.slot("overlay", function (host, ctx) {
    return watched(ctx, function () {
      host.replaceChildren();
      if (!ctx.runtime.ui.find) {
        return;
      }
      const bar = el("div", "sm-find cc-floating");
      const input = el("input");
      input.placeholder = "Find in this chat";
      input.setAttribute("aria-label", "Find in this chat");
      input.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
          ctx.runtime.ui.find = false;
          ctx.runtime.emit("change");
        }
      });
      bar.appendChild(input);
      host.appendChild(bar);
      input.focus();
    });
  }, FALLBACK);

  CC.Keys.bind("mod+f", {
    scope: "pane",
    when: function () {
      const pane = CC.Shell.focused();
      return pane != null && pane.kind === "chat";
    },
    run: function () {
      const rt = CC.Chats.open(CC.Shell.focused().chatId);
      rt.ui.find = !rt.ui.find;
      rt.emit("change");
    },
  });
};
