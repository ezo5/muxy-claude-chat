// Pane kind `review`, params {source, checkout, turn?, commit?, range?, base?, path?}. Opens beside the chat:
// CC.Shell.open({kind: "review", chatId, params}, {beside: true}), which also retargets a pane that is already open.
CC.Panes.register("review", {
  title: function (ctx) {
    return ctx.view != null ? ctx.view.title() : "Review";
  },
  actions: function (ctx) {
    return ctx.view != null ? ctx.view.actions() : [];
  },
  mount: function (host, ctx) {
    const view = new CC.Review.View(host, ctx);
    return {
      unmount: function () {
        view.dispose();
      },
      onKey: function (e) {
        return view.onKey(e);
      },
      update: function (params) {
        view.update(params);
      },
    };
  },
});
