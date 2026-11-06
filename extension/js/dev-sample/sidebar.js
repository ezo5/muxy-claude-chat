// Sample sidebar: yields to the real one as soon as it registers.
CC.devSample.sidebar = function (root, env) {
  const el = CC.util.el;
  let view = "state";

  function pick(row, e) {
    const beside = e != null && (e.metaKey || e.ctrlKey);
    CC.Chats.markRead(row.id);
    env.shell.open({ kind: "chat", chatId: row.id }, { beside: beside });
  }

  function rowEl(row, shown) {
    let sub = null;
    if (row.state === "need") {
      sub = row.ask;
    } else if (row.state === "busy") {
      sub = row.now;
    }
    const unread = row.unread && !shown.has(row.id);
    const actions = [];
    const runtime = CC.Chats.open(row.id);
    const pending = runtime.chat.blocks.find(function (b) {
      return b.k === "permission";
    });
    if (pending != null) {
      actions.push(CC.ui.chip({
        label: "Allow once",
        onClick: function () {
          CC.Chats.answer(row.id, pending.id, "allow");
        },
      }));
    }
    return CC.ui.listRow({
      title: row.title,
      sub: sub,
      subTone: row.state === "need" ? "need" : null,
      mark: CC.ui.stateMark(row.state, { unread: unread }),
      strong: unread,
      quiet: row.state === "stopped",
      active: shown.has(row.id),
      actions: actions,
      onClick: function (e) {
        pick(row, e);
      },
    });
  }

  function group(tree, title, rows, shown) {
    if (rows.length === 0) {
      return;
    }
    const head = el("div", "sm-group", title + " ");
    head.appendChild(el("b", null, String(rows.length)));
    tree.appendChild(head);
    rows.forEach(function (r) {
      tree.appendChild(rowEl(r, shown));
    });
  }

  function renderTree(tree) {
    tree.replaceChildren();
    const rows = CC.Chats.rows();
    const shown = new Set(env.shell.panes().map(function (p) {
      return p.chatId;
    }));
    function by(states) {
      return rows.filter(function (r) {
        return states.indexOf(r.state) >= 0;
      });
    }
    if (view === "project") {
      const projects = [];
      rows.forEach(function (r) {
        if (projects.indexOf(r.projectId) < 0) {
          projects.push(r.projectId);
        }
      });
      projects.forEach(function (p) {
        group(tree, p, rows.filter(function (r) {
          return r.projectId === p;
        }), shown);
      });
      return;
    }
    group(tree, "Needs you", by(["need"]), shown);
    group(tree, "Working", by(["busy"]), shown);
    group(tree, "Recent", by(["idle", "stopped"]), shown);
  }

  const top = el("div", "sm-side-top");
  const add = el("button", "sm-new");
  add.type = "button";
  add.appendChild(CC.ui.icon("plus"));
  add.appendChild(el("span", null, "New chat"));
  add.addEventListener("click", function () {
    CC.Chats.create({}).then(function (id) {
      env.shell.open({ kind: "chat", chatId: id });
    });
  });
  top.appendChild(add);

  const views = el("div", "sm-side-view");
  views.setAttribute("role", "group");
  views.setAttribute("aria-label", "Group chats");
  const tree = el("nav", "sm-tree");
  [["state", "By state"], ["project", "By project"]].forEach(function (pair) {
    const b = el("button", null, pair[1]);
    b.type = "button";
    b.dataset.view = pair[0];
    b.classList.toggle("is-on", pair[0] === view);
    b.addEventListener("click", function () {
      view = pair[0];
      views.querySelectorAll("button").forEach(function (x) {
        x.classList.toggle("is-on", x.dataset.view === view);
      });
      renderTree(tree);
    });
    views.appendChild(b);
  });

  const foot = el("div", "sm-side-foot", CC.devSample.SERVER);

  root.appendChild(top);
  root.appendChild(views);
  root.appendChild(tree);
  root.appendChild(foot);
  renderTree(tree);

  const offChats = CC.Chats.on(function () {
    renderTree(tree);
  });
  const offShell = CC.bus.on("shell:changed", function () {
    renderTree(tree);
  });
  return {
    unmount: function () {
      offChats();
      offShell();
    },
  };
};
