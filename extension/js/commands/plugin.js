// `/plugin`: loaded plugins (system/init `plugins`, refreshed by reload_plugins; before the first turn the
// enabledPlugins of get_settings), Reload plugins / Reload skills. A pick opens the plugin's directory.
CC.Commands.add(["plugin", "plugins"], function (ctx) {
  const runtime = ctx.runtime;
  const util = CC.util;
  const el = util.el;
  const card = ctx.card;

  function button(text, run) {
    return CC.ui.button({ label: text, onClick: run });
  }

  function show(plugins, note) {
    const body = card.open("wrench", "Plugins", plugins.length + " loaded");
    const actions = el("div", "cc-cmd-actions");
    actions.append(button("Reload plugins", reloadPlugins), button("Reload skills", reloadSkills));
    body.appendChild(actions);
    if (note) {
      body.appendChild(el("div", "cc-cmd-note", note));
    }
    card.list(body, plugins.map(function (p) {
      const at = (p.source || "").split("@")[1] || "";
      return { label: p.name, desc: [p.version, at && at !== "builtin" ? at : ""].filter(Boolean).join(" · "),
        sub: p.path === "builtin" ? "built-in" : util.shortPath(p.path), path: p.path };
    }), {
      search: plugins.length > 8 ? "Filter plugins" : null,
      empty: "No plugins",
      action: "open folder",
      onPick: function (it) {
        if (it.path && it.path !== "builtin") {
          CC.Commands.open(runtime, it.path);
        }
      },
    });
  }

  async function reloadPlugins() {
    const body = card.open("wrench", "Plugins");
    body.appendChild(el("div", "cc-cmd-empty", "Reloading plugins…"));
    let r;
    try {
      r = await CC.Commands.control(runtime, "reload_plugins");
    } catch (e) {
      CC.Commands.toast("Reload failed: " + e.message, "error");
      return;
    }
    CC.Commands.toast("Reloaded: " + [[r.plugins, "plugin"], [r.commands, "skill"], [r.agents, "agent"]].map(function (p) {
      const n = (p[0] || []).length;
      return n + " " + p[1] + (n === 1 ? "" : "s");
    }).join(" · ") + (r.error_count > 0 ? " · " + r.error_count + " errors" : ""), r.error_count > 0 ? "error" : null);
    if (card.root.contains(body)) {
      show(r.plugins || [], null);
    }
  }

  async function reloadSkills() {
    try {
      const r = await CC.Commands.control(runtime, "reload_skills");
      CC.Commands.toast("Reloaded " + (r.skills || []).length + " skills");
    } catch (e) {
      CC.Commands.toast("Reload failed: " + e.message, "error");
    }
  }

  if (Array.isArray(runtime.meta().plugins)) {
    show(runtime.meta().plugins, null);
    return;
  }
  const body = card.open("wrench", "Plugins");
  body.appendChild(el("div", "cc-cmd-empty", "Loading…"));
  card.hints([]);
  CC.Commands.control(runtime, "get_settings").then(function (r) {
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
