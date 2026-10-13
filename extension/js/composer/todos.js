window.CC = window.CC || {};

// Pinned task list above the composer: the main agent's tasks (store.todos) since the last /clear.
CC.Composer.use(function (composer) {
  const util = CC.util;
  const el = util.el;
  const store = composer.deps.store;
  let collapsed = false;
  let shown = null;

  const box = el("div", "todos hidden");
  composer.above.appendChild(box);

  function render() {
    const todos = store.todos() || [];
    const done = todos.filter(function (t) {
      return t.status === "completed";
    }).length;
    const idle = !composer.isWorking();
    const sig = JSON.stringify([todos, idle, collapsed]);
    if (sig === shown) {
      return;
    }
    shown = sig;
    box.textContent = "";
    box.classList.toggle("hidden", todos.length === 0 || (done === todos.length && idle));
    box.classList.toggle("collapsed", collapsed);
    if (todos.length === 0) {
      return;
    }
    const current = todos.find(function (t) {
      return t.status === "in_progress";
    });
    const head = el("button", "todos-head");
    head.type = "button";
    head.title = collapsed ? "Show tasks" : "Hide tasks";
    const chev = util.icon("chevron");
    chev.classList.add("chev");
    head.appendChild(chev);
    head.appendChild(el("span", "todos-title", "Tasks"));
    head.appendChild(el("span", "todos-count", done + "/" + todos.length));
    if (current != null) {
      head.appendChild(el("span", "todos-current", current.activeForm || current.content));
    }
    head.addEventListener("click", function () {
      collapsed = !collapsed;
      render();
    });
    box.appendChild(head);
    if (collapsed) {
      return;
    }
    const list = el("ul", "todo-list todos-list");
    todos.forEach(function (t) {
      const li = el("li", "todo " + (t.status || "pending"));
      li.appendChild(util.icon(t.status === "completed" ? "checkSquare" : t.status === "in_progress" ? "circleDot" : "square"));
      li.appendChild(el("span", null, t.content));
      list.appendChild(li);
    });
    box.appendChild(list);
  }

  ["reset", "items:add", "items:prepend", "items:update"].forEach(function (name) {
    store.on(name, render);
  });
  composer.on("status", function () {
    render();
    return false;
  });
  render();
});
