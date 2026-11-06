// The rail's cards. Each folds to one line and describes the focused chat; the shell rebuilds them on a change of chat.
(function () {
  const util = CC.util;
  const el = util.el;

  function modelOf(ctx) {
    return ctx != null && ctx.runtime != null ? CC.RailData.of(ctx.runtime) : null;
  }

  // An icon says which it is; the name stays for the tooltip and screen readers.
  function fieldRow(name, icon) {
    const row = el("div", "cc-env-row");
    const mark = el("span", "cc-env-icon");
    mark.title = name;
    mark.appendChild(CC.ui.icon(icon, 14));
    row.appendChild(mark);
    row.appendChild(el("span", "cc-env-key", name));
    const value = el("span", "cc-env-value");
    row.appendChild(value);
    return { row: row, value: value };
  }

  CC.Rail.register("environment", {
    title: "Environment",
    icon: "globe",
    order: 10,
    status: function (ctx) {
      const model = modelOf(ctx);
      if (model == null) {
        return null;
      }
      const branch = model.git != null ? model.git.branch : null;
      return branch || model.meta().branch || null;
    },
    mount: function (host, ctx) {
      const model = CC.RailData.of(ctx.runtime);
      const release = model.acquire();
      const server = fieldRow("Server", "monitor");
      const folder = fieldRow("Folder", "folder");
      const branch = fieldRow("Branch", "branch");
      branch.value.classList.add("is-branch");
      server.row.hidden = true;
      host.appendChild(server.row);
      host.appendChild(folder.row);
      host.appendChild(branch.row);
      let gone = false;
      CC.RailData.server(ctx.runtime).then(function (name) {
        if (!gone && name != null) {
          server.value.textContent = name;
          server.value.title = name;
          server.row.hidden = false;
        }
      });

      function paint() {
        const cwd = model.cwd();
        folder.value.textContent = cwd != null ? util.shortPath(cwd) : "";
        folder.value.title = cwd || "";
        folder.row.hidden = cwd == null;
        const name = (model.git != null ? model.git.branch : null) || model.meta().branch || model.meta().gitBranch || null;
        branch.value.replaceChildren();
        if (name != null) {
          const text = el("span", "cc-env-branch", name);
          text.title = name;
          branch.value.appendChild(text);
        }
        if (model.git != null && model.git.worktree) {
          branch.value.appendChild(CC.ui.chip({ label: "Worktree" }));
        }
        branch.row.hidden = name == null;
      }
      const off = model.on(paint);
      paint();
      return {
        unmount: function () {
          gone = true;
          off();
          release();
        },
      };
    },
  });

  CC.Rail.register("context", {
    title: "Context",
    icon: "gauge",
    order: 20,
    status: function (ctx) {
      const model = modelOf(ctx);
      return model != null ? CC.RailContext.statusOf(model) : null;
    },
    mount: function (host, ctx) {
      return CC.RailContext.mount(host, ctx);
    },
  });

  CC.Rail.register("changes", {
    title: "Changes",
    icon: "diff",
    order: 30,
    visible: function (ctx) {
      const model = modelOf(ctx);
      return model != null && model.git != null && model.git.files > 0;
    },
    status: function (ctx) {
      const git = modelOf(ctx).git;
      return git != null ? "+" + git.add + " −" + git.del : null;
    },
    mount: function (host, ctx) {
      const model = CC.RailData.of(ctx.runtime);
      const release = model.acquire();
      const line = el("div", "cc-changes-line");
      const review = CC.ui.button({
        label: "Review changes",
        primary: true,
        onClick: function () {
          ctx.shell.open({ kind: "review", chatId: ctx.chatId }, { beside: true });
        },
      });
      review.classList.add("cc-rail-wide");
      host.appendChild(line);
      host.appendChild(review);

      function paint() {
        const git = model.git;
        if (git == null) {
          return;
        }
        line.replaceChildren(el("span", null, git.files + (git.files === 1 ? " file " : " files ")), CC.ui.numbers(git.add, git.del));
      }
      const off = model.on(paint);
      paint();
      return {
        unmount: function () {
          off();
          release();
        },
      };
    },
  });

  function todosOf(ctx) {
    const store = ctx != null && ctx.runtime != null ? ctx.runtime.store : null;
    return store != null && typeof store.todos === "function" ? store.todos() || [] : [];
  }

  function taskRow(t) {
    const row = el("div", "cc-task is-" + (t.status || "pending"));
    const mark = el("span", "cc-task-mark");
    if (t.status === "completed") {
      mark.appendChild(CC.ui.icon("check", 14));
    } else if (t.status === "in_progress") {
      mark.appendChild(CC.ui.spinner());
    } else {
      mark.appendChild(CC.ui.icon("todoRing", 14));
    }
    row.appendChild(mark);
    row.appendChild(el("span", "cc-task-text", t.status === "in_progress" ? t.activeForm || t.content : t.content));
    return row;
  }

  CC.Rail.register("tasks", {
    title: "Tasks",
    icon: "listChecks",
    order: 15,
    visible: function (ctx) {
      return todosOf(ctx).length > 0;
    },
    status: function (ctx) {
      const todos = todosOf(ctx);
      return todos.filter(function (t) {
        return t.status === "completed";
      }).length + " of " + todos.length;
    },
    mount: function (host, ctx) {
      const model = CC.RailData.of(ctx.runtime);
      const release = model.acquire();
      let shown = null;
      function paint() {
        const todos = todosOf(ctx);
        const signature = JSON.stringify(todos);
        if (signature !== shown) {
          shown = signature;
          host.replaceChildren.apply(host, todos.map(taskRow));
        }
      }
      const off = model.on(paint);
      paint();
      return {
        unmount: function () {
          off();
          release();
        },
      };
    },
  });

  CC.Rail.register("agents", {
    title: "Agents",
    icon: "bot",
    order: 50,
    status: function (ctx) {
      const model = modelOf(ctx);
      return model != null ? CC.RailAgents.statusOf(model) : null;
    },
    mount: function (host, ctx) {
      return CC.RailAgents.mount(host, ctx);
    },
  });
})();
