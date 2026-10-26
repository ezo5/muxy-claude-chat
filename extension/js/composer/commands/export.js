window.CC = window.CC || {};

// `/export`: the Markdown export from Settings (written next to the project; the file name is generated).
CC.Commands.add("export", function (ctx) {
  return ctx.composer.deps.exportMarkdown();
});
