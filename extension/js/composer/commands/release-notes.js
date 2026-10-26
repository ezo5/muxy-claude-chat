window.CC = window.CC || {};

// `/release-notes`: the changelog the CLI caches in ~/.claude/cache/changelog.md (reader `changelog`), newest first,
// 10 versions at a time.
CC.Commands.add("release-notes", async function (ctx) {
  const util = CC.util;
  const el = util.el;
  const card = ctx.card;
  const current = ctx.composer.meta.cliVersion;
  const body = card.open("list", "Release notes", current ? "running " + current : "");
  const notes = el("div", "release-notes");
  body.appendChild(notes);
  const actions = el("div", "cmd-actions");
  const more = el("button", "chip-btn", "Older versions");
  more.type = "button";
  actions.appendChild(more);
  body.appendChild(actions);
  card.hints([]);
  const root = card.root;
  let shown = 0;

  async function load() {
    more.disabled = true;
    let r;
    try {
      r = await CC.host.reader("changelog", { skip: shown, limit: 10 });
    } catch (e) {
      notes.appendChild(el("div", "picker-empty", "Release notes unavailable: " + e.message));
      return;
    }
    if (!root.contains(notes)) {
      return;
    }
    if (r.missing) {
      notes.appendChild(el("div", "picker-empty", "No cached changelog yet (" + util.shortPath(r.path) + "). The interactive Claude Code downloads it in the background."));
      more.classList.add("hidden");
      return;
    }
    const md = r.versions.map(function (v) {
      return "## " + v.version + (v.version === current ? " (installed)" : "") + "\n\n" + v.text;
    }).join("\n\n");
    notes.appendChild(CC.markdown.render(md));
    shown += r.versions.length;
    more.classList.toggle("hidden", shown >= r.total);
    more.disabled = false;
  }

  more.addEventListener("click", load);
  await load();
});
