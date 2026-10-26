window.CC = window.CC || {};

// `/agents`: subagent definitions from the initialize reply (name, description, model; no path or source on the wire).
// A pick shows the details; Open file tries .claude/agents/<name>.md in the project, then in ~/.claude.
CC.Commands.add("agents", function (ctx) {
  const util = CC.util;
  const el = util.el;
  const card = ctx.card;
  const composer = ctx.composer;
  const defs = composer.meta.agentDefs || [];

  function list() {
    const body = card.open("agents", "Agents", defs.length + " available");
    card.list(body, defs.map(function (a) {
      return { label: a.name, desc: util.firstLine(a.description, 200), sub: a.model ? "model: " + a.model : "", agent: a };
    }), {
      search: "Filter agents…",
      query: ctx.arg,
      empty: "No agents reported yet (start Claude first)",
      action: "details",
      onPick: function (it) {
        detail(it.agent);
      },
    });
  }

  async function openFile(a) {
    const name = a.name.replace(/[^\w.-]/g, "");
    const cwd = composer.meta.cwd || ".";
    for (const path of [cwd + "/.claude/agents/" + name + ".md", "~/.claude/agents/" + name + ".md"]) {
      try {
        await CC.openPath(path);
        return;
      } catch (e) {
        if (!/not found/.test(e && e.message)) {
          util.toast("Open failed: " + e.message, "error");
          return;
        }
      }
    }
    util.toast("No .claude/agents/" + name + ".md (built-in or plugin agent)", "error");
  }

  function detail(a) {
    const body = card.open("agents", a.name);
    card.rows(body, [["Model", a.model || "default"], ["Description", a.description]]);
    const actions = el("div", "cmd-actions");
    const back = el("button", "chip-btn", "Back");
    back.type = "button";
    back.addEventListener("click", list);
    const open = el("button", "chip-btn primary", "Open file");
    open.type = "button";
    open.addEventListener("click", function () {
      openFile(a);
    });
    actions.append(back, open);
    body.appendChild(actions);
    card.hints([]);
    open.focus();
  }

  list();
});
