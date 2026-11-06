// `/usage`: the view is C5's, this only gives it a card.
CC.Commands.add("usage", function (ctx) {
  const body = ctx.card.open("sparkle", "Usage");
  ctx.card.hints([]);
  return CC.Usage.render(body, {
    chatId: ctx.runtime.id,
    runtime: ctx.runtime,
    composer: ctx.composer,
    card: ctx.card,
    close: function () {
      ctx.card.close();
    },
  });
});
