window.CC = window.CC || {};

// `/todos`: the main agent's task list (store.todos, also pinned above the composer while in progress).
CC.Commands.add("todos", function (ctx) {
  const util = CC.util;
  const el = util.el;
  const card = ctx.card;
  const todos = ctx.composer.deps.store.todos() || [];
  const done = todos.filter(function (t) {
    return t.status === "completed";
  }).length;
  const body = card.open("checkSquare", "Tasks", todos.length > 0 ? done + "/" + todos.length + " done" : "");
  if (todos.length === 0) {
    body.appendChild(el("div", "picker-empty", "No tasks since the last /clear"));
  } else {
    const list = el("ul", "todo-list");
    todos.forEach(function (t) {
      const li = el("li", "todo " + (t.status || "pending"));
      li.appendChild(util.icon(t.status === "completed" ? "checkSquare" : t.status === "in_progress" ? "circleDot" : "square"));
      li.appendChild(el("span", null, t.status === "in_progress" && t.activeForm ? t.activeForm : t.content));
      list.appendChild(li);
    });
    body.appendChild(list);
  }
  card.hints([]);
});
