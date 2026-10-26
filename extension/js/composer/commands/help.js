window.CC = window.CC || {};

// `/help`: every command (the CLI's live list + the built-ins answered here); a pick puts it into the composer.
CC.Commands.add("help", function (ctx) {
  const composer = ctx.composer;
  const cmds = composer.slashCommands().slice().sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });
  const body = ctx.card.open("list", "Commands", cmds.length + " available");
  ctx.card.list(body, cmds.map(function (c) {
    const tag = c.local ? "answered in the chat" : c.dialog ? "terminal only" : c.source && c.source !== "built-in" ? c.source : "";
    return {
      label: "/" + c.name + (c.hint ? " " + c.hint : ""),
      desc: c.desc,
      sub: tag,
      name: c.name,
    };
  }), {
    search: "Filter commands…",
    query: ctx.arg,
    action: "insert",
    onPick: function (it) {
      composer.setValue("/" + it.name + " ");
      composer.focus();
    },
  });
});
