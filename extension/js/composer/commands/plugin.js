window.CC = window.CC || {};

// `/plugin`: loaded plugins (system/init `plugins`, refreshed by reload_plugins; before the first turn the
// enabledPlugins of get_settings), Reload plugins / Reload skills. A pick opens the plugin's directory.
CC.Commands.add(["plugin", "plugins"], function (ctx) {
  const util = CC.util;
  const el = util.el;
  const card = ctx.card;
  const composer = ctx.composer;

  function button(text, run) {
    const b = el("button", "chip-btn", text);
    b.type = "button";
    b.addEventListener("click", run);
    return b;
  }

  function show(plugins, note) {
    const body = card.open("wrench", "Plugins", plugins.length + " loaded");
    const actions = el("div", "cmd-actions");
    actions.append(button("Reload plugins", reloadPlugins), button("Reload skills", reloadSkills));
    body.appendChild(actions);
    if (note) {
      body.appendChild(el("div", "cmd-note", note));
    }
    card.list(body, plugins.map(function (p) {
      const at = (p.source || "").split("@")[1] || "";
      return { label: p.name, desc: [p.version, at && at !== "builtin" ? at : ""].filter(Boolean).join(" · "),
        sub: p.path === "builtin" ? "built-in" : util.shortPath(p.path), path: p.path };
    }), {
      search: plugins.length > 8 ? "Filter plugins…" : null,
      empty: "No plugins",
      action: "open folder",
      onPick: function (it) {
        if (it.path && it.path !== "builtin") {
          CC.Commands.open(it.path);
        }
      },
    });
  }

  async function reloadPlugins() {
    const body = card.open("wrench", "Plugins");
    body.appendChild(el("div", "picker-empty", "Reloading plugins…"));
    let r;
    try {
      r = await CC.Commands.control(composer, "reload_plugins");
    } catch (e) {
      util.toast("Reload failed: " + e.message, "error");
      return;
    }
    util.toast("Reloaded: " + [[r.plugins, "plugin"], [r.commands, "skill"], [r.agents, "agent"]].map(function (p) {
      const n = (p[0] || []).length;
      return n + " " + p[1] + (n === 1 ? "" : "s");
    }).join(" · ") + (r.error_count > 0 ? " · " + r.error_count + " errors" : ""), r.error_count > 0 ? "error" : null);
    if (card.root.contains(body)) {
      show(r.plugins || [], null);
    }
  }

  async function reloadSkills() {
    try {
      const r = await CC.Commands.control(composer, "reload_skills");
      util.toast("Reloaded " + (r.skills || []).length + " skills");
    } catch (e) {
      util.toast("Reload failed: " + e.message, "error");
    }
  }

  if (Array.isArray(composer.meta.plugins)) {
    show(composer.meta.plugins, null);
    return;
  }
  const body = card.open("wrench", "Plugins");
  body.appendChild(el("div", "picker-empty", "Loading…"));
  card.hints([]);
  CC.Commands.control(composer, "get_settings").then(function (r) {
    const on = ((r.effective || {}).enabledPlugins) || {};
    if (card.root.contains(body)) {
      show(Object.keys(on).filter(function (k) {
        return on[k] === true;
      }).map(function (k) {
        return { name: k.split("@")[0], source: k };
      }), "Enabled in settings; the loaded list arrives with the first turn.");
    }
  }, function (e) {
    if (card.root.contains(body)) {
      show([], "Plugins unavailable: " + e.message);
    }
  });
});
