window.CC = window.CC || {};

// `/config`: the chat's Settings dialog.
CC.Commands.add("config", function (ctx) {
  ctx.composer.deps.openSettings();
});
