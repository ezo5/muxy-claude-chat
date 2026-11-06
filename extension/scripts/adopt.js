// Adopt the focused terminal's Claude. Unlike the others this never opens a terminal: one is already there, or there's nothing to adopt.

function adopt() {
  let pane = null;
  try {
    pane = muxy.panes.list().find(function (p) {
      return p.isFocused === true;
    }) || null;
  } catch (e) {
    say("Couldn't read the terminals: " + why(e));
    return;
  }
  if (pane == null) {
    say("Focus the terminal with Claude first.");
    return;
  }
  const check = checkServer();
  if (check.failure != null) {
    say("Claude Chat couldn't check this server: " + check.failure);
    return;
  }
  if (check.result.experience !== "chat") {
    const text = CC.probeCore.message(check.result);
    say(text != null ? text.replace(", so this opens a terminal", "") : "This server has no Claude Code.");
    return;
  }
  openApp(activeProject(), { kind: "adopt", paneId: String(pane.id) });
}

adopt();
