window.CC = window.CC || {};

// `/tasks` (`/bashes`): background agents and commands of this session, the agents sidebar's rows (agent_tracker).
// Enter opens one: get_task_output tail (polled while running) and stop_task.
CC.Commands.add(["tasks", "bashes"], async function (ctx) {
  const util = CC.util;
  const el = util.el;
  const composer = ctx.composer;
  const card = ctx.card;
  const store = composer.deps.store;
  const agents = composer.deps.agents;

  function ms(t) {
    return t == null ? null : new Date(t).getTime();
  }

  function runtime(t) {
    const a = ms(t.startTs);
    return a == null ? "" : util.fmtDuration((t.status === "running" ? Date.now() : ms(t.endTs) || Date.now()) - a);
  }

  function taskId(t) {
    return t.taskId || t.agentId;
  }

  function command(t) {
    const tool = store.tool(t.id);
    const input = tool != null ? tool.input || {} : {};
    return t.command || input.prompt || null;
  }

  function kind(t) {
    return t.kind === "bash" ? "shell" : t.type;
  }

  function tasks() {
    return agents.rows.filter(function (t) {
      return taskId(t) != null && t.background === true;
    }).sort(function (a, b) {
      return (b.status === "running") - (a.status === "running") || (ms(b.startTs) || 0) - (ms(a.startTs) || 0);
    });
  }

  function showList() {
    const list = tasks();
    const running = list.filter(function (t) {
      return t.status === "running";
    }).length;
    const body = card.open("terminal", "Background tasks", list.length === 0 ? "" : running + " running");
    card.list(body, list.map(function (t) {
      const cmd = command(t);
      return { label: t.description || util.firstLine(cmd || taskId(t), 120), desc: cmd && cmd !== t.description ? util.firstLine(cmd, 160) : "",
        sub: [kind(t), t.status, runtime(t)].filter(Boolean).join(" · "), task: t };
    }), {
      action: "open",
      empty: "No background tasks in this session",
      onPick: function (it) {
        showTask(it.task);
      },
    });
  }

  function showTask(t) {
    const body = card.open("terminal", t.description || "Task", taskId(t));
    const status = el("span", null, t.status);
    card.rows(body, [["Command", command(t)], ["Type", kind(t)], ["Status", status]]);
    const out = el("pre", "cmd-out task-out", "Loading…");
    body.appendChild(out);
    const actions = el("div", "cmd-actions");
    const back = el("button", "chip-btn", "Back");
    back.type = "button";
    back.addEventListener("click", showList);
    const stop = el("button", "chip-btn primary", "Stop task");
    stop.type = "button";
    stop.addEventListener("click", async function () {
      stop.disabled = true;
      try {
        await CC.Commands.control(composer, "stop_task", { task_id: taskId(t) });
        status.textContent = "stopping…";
        agents.kick(1000, true);
      } catch (e) {
        util.toast("Stop failed: " + e.message, "error");
        stop.disabled = false;
      }
    });
    actions.append(back, stop);
    body.appendChild(actions);
    card.hints([]);
    back.focus();

    async function poll() {
      while (card.root.contains(out)) {
        const cur = agents.rows.find(function (r) {
          return r.id === t.id;
        }) || t;
        status.textContent = [cur.status || "—", runtime(cur)].filter(Boolean).join(" · ");
        stop.classList.toggle("hidden", cur.status !== "running");
        try {
          const r = await CC.Commands.control(composer, "get_task_output", { task_id: taskId(t) });
          const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 4;
          out.textContent = (r.truncated ? "… (last 8 KiB of " + r.total_bytes + " bytes)\n" : "") + (r.output || "(no output yet)");
          if (atEnd) {
            out.scrollTop = out.scrollHeight;
          }
        } catch (e) {
          out.textContent = "No output: " + e.message;
          return;
        }
        if (cur.status !== "running") {
          return;
        }
        await util.sleep(1500);
      }
    }
    poll();
  }

  await agents.poll(true);
  showList();
});
