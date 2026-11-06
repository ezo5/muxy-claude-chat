// `/todos`: the main agent's task list (store.todos, also a card in the flow while in progress).
CC.Commands.add("todos", function (ctx) {
  const runtime = ctx.runtime;
  const util = CC.util;
  const el = util.el;
  const card = ctx.card;
  const todos = runtime.store.todos() || [];
  const done = todos.filter(function (t) {
    return t.status === "completed";
  }).length;
  const body = card.open("checkSquare", "Tasks", todos.length > 0 ? done + "/" + todos.length + " done" : "");
  if (todos.length === 0) {
    body.appendChild(el("div", "cc-cmd-empty", "No tasks since the last /clear"));
  } else {
    const list = el("ul", "cc-cmd-todos");
    todos.forEach(function (t) {
      const li = el("li", "cc-cmd-todo is-" + (t.status || "pending"));
      li.appendChild(CC.ui.icon(t.status === "completed" ? "checkSquare" : t.status === "in_progress" ? "circleDot" : "square", 14));
      li.appendChild(el("span", null, t.status === "in_progress" && t.activeForm ? t.activeForm : t.content));
      list.appendChild(li);
    });
    body.appendChild(list);
  }
  card.hints([]);
});
