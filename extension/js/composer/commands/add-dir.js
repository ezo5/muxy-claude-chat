window.CC = window.CC || {};

// `/add-dir [path]`: the CLI's add_directory control only stages remote mounts and the command is off in -p, so the
// daemon restarts (resuming the conversation) with the extra --add-dir; the list is kept for later resumes.
CC.Commands.add("add-dir", async function (ctx) {
  const util = CC.util;
  const el = util.el;
  const composer = ctx.composer;
  const card = ctx.card;
  const dirs = Array.isArray(composer.meta.addDirs) ? composer.meta.addDirs : [];

  if (ctx.arg === "") {
    const body = card.open("file", "Working directories", composer.meta.cwd ? util.shortPath(composer.meta.cwd) : "");
    const list = el("div", "cmd-list");
    dirs.forEach(function (d) {
      const row = el("div", "cmd-item");
      row.appendChild(el("span", "cmd-dot cmd-ok"));
      row.appendChild(el("span", "cmd-item-name", d));
      list.appendChild(row);
    });
    body.appendChild(el("div", "cmd-note", dirs.length === 0 ? "No additional directories." : "Additional directories Claude can read and edit:"));
    body.appendChild(list);
    body.appendChild(el("div", "cmd-note", "Add one with /add-dir <path> (absolute, ~/… or relative to the working directory). Claude restarts and resumes this conversation."));
    card.hints([]);
    return;
  }
  const r = await CC.host.reader("resolveDir", { cwd: composer.meta.cwd, path: ctx.arg });
  if (!r.isDir) {
    util.toast("Not a directory: " + r.path, "error");
    return;
  }
  if (dirs.indexOf(r.path) >= 0 || r.path === composer.meta.cwd) {
    util.toast("Already a working directory: " + r.path);
    return;
  }
  if (composer.isWorking()) {
    util.toast("Adding a directory restarts Claude — try again when it is idle", "error");
    return;
  }
  util.toast("Adding " + r.path + " — restarting Claude…");
  await composer.deps.restart({ addDirs: dirs.concat([r.path]) });
});
