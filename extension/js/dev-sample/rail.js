// Sample rail cards. Real cards with the same id take over one at a time.
CC.devSample.registerRail = function () {
  const el = CC.util.el;

  function kv(key, value) {
    const row = el("div", "sm-kv");
    row.appendChild(el("span", null, key));
    row.appendChild(el("span", null, value));
    return row;
  }

  function serverCheck(host) {
    const out = el("div", "sm-check");
    const b = CC.ui.button({
      label: "Check this server",
      onClick: function () {
        out.textContent = "Checking…";
        CC.host.probe({ fresh: true }).then(function (r) {
          const parts = ["Experience: " + r.experience];
          if (r.claude != null) {
            parts.push("Claude Code " + r.claude.version + " at " + r.claude.path);
          }
          if (r.python != null) {
            parts.push("Python " + r.python.version + " at " + r.python.path);
          }
          if (r.missing != null) {
            parts.push("Missing: " + r.missing);
          }
          out.textContent = parts.join("\n");
        }).catch(function (e) {
          out.textContent = "Couldn't check: " + e.message;
        });
      },
    });
    b.classList.add("sm-wide");
    host.appendChild(b);
    host.appendChild(out);
  }

  CC.Rail.register("environment", {
    fallback: true,
    title: "Environment",
    order: 10,
    mount: function (host, ctx) {
      const c = ctx.runtime.chat;
      host.appendChild(kv("Server", CC.devSample.SERVER));
      host.appendChild(kv("Folder", c.path));
      host.appendChild(kv("Branch", c.branch));
      serverCheck(host);
      return null;
    },
  });

  CC.Rail.register("context", {
    fallback: true,
    title: "Context",
    order: 20,
    status: function (ctx) {
      const c = ctx.runtime.chat;
      return Math.round(c.ctx[0] / c.ctx[1] * 100) + "%";
    },
    mount: function (host, ctx) {
      const c = ctx.runtime.chat;
      const pct = c.ctx[0] / c.ctx[1] * 100;
      const parts = [["Messages", 52, "var(--accent)"], ["Tools", 28, "color-mix(in srgb, var(--accent) 55%, var(--bg))"], ["Memory", 20, "var(--muted)"]];
      host.appendChild(el("div", "sm-grey", c.ctx[0] + "k of " + c.ctx[1] + "k used"));
      const bar = el("div", "sm-bar");
      parts.forEach(function (p) {
        const segment = el("i");
        segment.style.width = (pct * p[1] / 100) + "%";
        segment.style.background = p[2];
        bar.appendChild(segment);
      });
      host.appendChild(bar);
      parts.forEach(function (p) {
        const row = el("div", "sm-legend");
        const dot = el("em");
        dot.style.background = p[2];
        row.appendChild(dot);
        row.appendChild(el("span", "sm-grow", p[0]));
        row.appendChild(document.createTextNode(Math.round(c.ctx[0] * p[1] / 100) + "k"));
        host.appendChild(row);
      });
      const compact = CC.ui.button({ label: "Compact now" });
      compact.classList.add("sm-wide");
      host.appendChild(compact);
      return null;
    },
  });

  CC.Rail.register("changes", {
    fallback: true,
    title: "Changes",
    order: 30,
    visible: function (ctx) {
      return ctx.runtime.chat.changes[2] > 0;
    },
    mount: function (host, ctx) {
      const c = ctx.runtime.chat;
      const line = el("div", null, c.changes[2] + " files ");
      line.appendChild(CC.ui.numbers(c.changes[0], c.changes[1]));
      host.appendChild(line);
      const review = CC.ui.button({
        label: "Review changes",
        primary: true,
        onClick: function () {
          ctx.shell.open({ kind: "review", chatId: ctx.chatId }, { beside: true });
        },
      });
      review.classList.add("sm-wide");
      host.appendChild(review);
      return null;
    },
  });

  function tasksOf(ctx) {
    return ctx.runtime.chat.blocks.find(function (b) {
      return b.k === "tasks";
    });
  }

  CC.Rail.register("tasks", {
    fallback: true,
    title: "Tasks",
    order: 15,
    visible: function (ctx) {
      return tasksOf(ctx) != null;
    },
    status: function (ctx) {
      const items = tasksOf(ctx).items;
      const done = items.filter(function (t) {
        return t[0] === "done";
      }).length;
      return done + " of " + items.length;
    },
    mount: function (host, ctx) {
      tasksOf(ctx).items.forEach(function (t) {
        const row = el("div", "sm-task" + (t[0] === "done" ? " is-done" : ""));
        if (t[0] === "done") {
          row.appendChild(CC.ui.icon("check", 12));
        } else if (t[0] === "run") {
          row.appendChild(el("span", "cc-spin"));
        } else {
          row.appendChild(el("span", "sm-pending"));
        }
        row.appendChild(el("span", null, t[1]));
        host.appendChild(row);
      });
      return null;
    },
  });
};
