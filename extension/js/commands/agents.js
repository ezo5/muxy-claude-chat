// `/agents`: subagent definitions from the initialize reply (name, description, model; no path or source on the wire).
// A pick shows the details; Open file tries .claude/agents/<name>.md in the project, then in ~/.claude (CC.Commands.openAgent).
CC.Commands.add("agents", function (ctx) {
  const runtime = ctx.runtime;
  const util = CC.util;
  const el = util.el;
  const card = ctx.card;
  const defs = runtime.meta().agentDefs || [];

  function list() {
    const body = card.open("agents", "Agents", defs.length + " available");
    card.list(body, defs.map(function (a) {
      return { label: a.name, desc: util.firstLine(a.description, 200), sub: a.model ? "model: " + a.model : "", agent: a };
    }), {
      search: "Filter agents",
      query: ctx.arg,
      empty: "No agents reported yet (start Claude first)",
      action: "details",
      onPick: function (it) {
        detail(it.agent);
      },
    });
  }

  function detail(a) {
    const body = card.open("agents", a.name);
    card.rows(body, [["Model", a.model || "default"], ["Description", a.description]]);
    const actions = el("div", "cc-cmd-actions");
    const back = CC.ui.button({ label: "Back" });
    back.addEventListener("click", list);
    const open = CC.ui.button({ label: "Open file", primary: true });
    open.addEventListener("click", function () {
      CC.Commands.openAgent(runtime, a.name);
    });
    actions.append(back, open);
    body.appendChild(actions);
    card.hints([]);
    open.focus();
  }

  list();
});
