window.CC = window.CC || {};

// `/ide`: IDE integration needs the TUI, so offer terminal mode.
CC.Commands.add("ide", function (ctx) {
  const el = CC.util.el;
  const card = ctx.card;
  const body = card.open("terminal", "Connect to an IDE");
  body.appendChild(el("div", "cmd-note", "IDE integration (open files, selections, diffs in the editor) runs in the interactive Claude Code "
    + "terminal, not in this headless chat. Continue this conversation in terminal mode and run /ide there."));
  const actions = el("div", "cmd-actions");
  const btn = el("button", "chip-btn primary", "Switch to terminal mode");
  btn.type = "button";
  btn.addEventListener("click", function () {
    card.close();
    ctx.composer.deps.toTerminal();
  });
  actions.appendChild(btn);
  body.appendChild(actions);
  card.hints([]);
  btn.focus();
});
