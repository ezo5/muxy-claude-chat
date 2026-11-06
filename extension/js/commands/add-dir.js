// `/add-dir [path]`: the CLI's add_directory control only stages remote mounts and the command is off in -p, so the
// daemon restarts (resuming the conversation) with the extra --add-dir; the list is kept for later resumes.
CC.Commands.add("add-dir", async function (ctx) {
  const runtime = ctx.runtime;
  const util = CC.util;
  const el = util.el;
  const card = ctx.card;
  const dirs = Array.isArray(runtime.meta().addDirs) ? runtime.meta().addDirs : [];

  if (ctx.arg === "") {
    const body = card.open("file", "Working directories", runtime.meta().cwd ? util.shortPath(runtime.meta().cwd) : "");
    const list = el("div", "cc-cmd-list");
    dirs.forEach(function (d) {
      const row = el("div", "cc-cmd-item");
      row.appendChild(el("span", "cmd-dot cmd-ok"));
      row.appendChild(el("span", "cc-cmd-item-name", d));
      list.appendChild(row);
    });
    body.appendChild(el("div", "cc-cmd-note", dirs.length === 0 ? "No additional directories." : "Additional directories Claude can read and edit:"));
    body.appendChild(list);
    body.appendChild(el("div", "cc-cmd-note", "Add one with /add-dir <path> (absolute, ~/… or relative to the working directory). Claude restarts and resumes this conversation."));
    card.hints([]);
    return;
  }
  const r = await CC.Servers.of(runtime).host.call("resolveDir", { cwd: runtime.meta().cwd, path: ctx.arg });
  if (!r.isDir) {
    CC.Commands.toast("Not a directory: " + r.path, "error");
    return;
  }
  if (dirs.indexOf(r.path) >= 0 || r.path === runtime.meta().cwd) {
    CC.Commands.toast("Already a working directory: " + r.path);
    return;
  }
  if (CC.Commands.isWorking(runtime)) {
    CC.Commands.toast("Adding a directory restarts Claude — try again when it is idle", "error");
    return;
  }
  CC.Commands.toast("Adding " + r.path + " — restarting Claude…");
  await runtime.restart({ addDirs: dirs.concat([r.path]) });
});
