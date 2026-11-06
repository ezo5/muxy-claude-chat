// `/config`: Settings, beside what you're reading. The section name is optional: `/config typography`.
CC.Commands.add("config", function (ctx) {
  CC.SettingsView.open({ section: ctx.arg.toLowerCase() || null });
});
