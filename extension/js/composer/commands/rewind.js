window.CC = window.CC || {};

// `/rewind`: pick one of the loaded prompts, then the same menu as the bubble's "Rewind to here".
CC.Commands.add("rewind", function (ctx) {
  const util = CC.util;
  const composer = ctx.composer;
  const rewind = composer.deps.rewind;
  if (!rewind.ready()) {
    return;
  }
  const items = composer.deps.store.items.filter(function (it) {
    return rewind.target(it) != null;
  }).reverse();
  const body = ctx.card.open("rewind", "Rewind to…", "Claude forgets the prompt and everything after it");
  ctx.card.list(body, items.map(function (it) {
    return {
      label: util.firstLine(it.text, 200) || "(image)",
      sub: it.ts ? new Date(it.ts).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "",
      item: it,
    };
  }), {
    search: "Filter prompts…",
    empty: "No prompts to rewind to in this conversation",
    action: "rewind",
    onPick: function (it) {
      rewind.open(it.item, composer.box);
    },
  });
});
