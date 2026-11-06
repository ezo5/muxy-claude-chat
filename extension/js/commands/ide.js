// `/ide`: IDE integration needs the TUI, so offer terminal mode.
CC.Commands.add("ide", function (ctx) {
  const runtime = ctx.runtime;
  const el = CC.util.el;
  const card = ctx.card;
  const body = card.open("terminal", "Connect to an IDE");
  body.appendChild(el("div", "cc-cmd-note", "IDE integration (open files, selections, diffs in the editor) runs in the interactive Claude Code "
    + "terminal, not in this headless chat. Continue this conversation in terminal mode and run /ide there."));
  const actions = el("div", "cc-cmd-actions");
  const btn = CC.ui.button({ label: "Switch to terminal mode", primary: true });
  btn.addEventListener("click", function () {
    card.close();
    runtime.toTerminal();
  });
  actions.appendChild(btn);
  body.appendChild(actions);
  card.hints([]);
  btn.focus();
});
