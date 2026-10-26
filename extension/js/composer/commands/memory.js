window.CC = window.CC || {};

// `/memory`: instruction files and auto memories from get_memory_dialog, token counts from get_context_usage
// `memoryFiles` (also the fallback list); a pick opens the file.
CC.Commands.add("memory", async function (ctx) {
  const util = CC.util;
  const el = util.el;
  const card = ctx.card;
  const composer = ctx.composer;
  const body = card.open("brain", "Memory");
  body.appendChild(el("div", "picker-empty", "Loading…"));
  card.hints([]);
  const res = await Promise.allSettled([
    CC.Commands.control(composer, "get_memory_dialog"),
    CC.Commands.control(composer, "get_context_usage", { detail: "summary" }),
  ]);
  if (!card.root.contains(body)) {
    return;
  }
  const dialog = res[0].status === "fulfilled" ? res[0].value : null;
  const loaded = res[1].status === "fulfilled" ? res[1].value.memoryFiles || [] : [];
  if (dialog == null && res[1].status === "rejected") {
    body.textContent = "";
    body.appendChild(el("div", "picker-empty", "Memory unavailable: " + res[0].reason.message));
    return;
  }
  const tokens = {};
  loaded.forEach(function (f) {
    tokens[f.path] = f.tokens;
  });
  const cwd = composer.meta.cwd;
  function size(path) {
    return tokens[path] != null ? util.fmtTokens(tokens[path]) + " tokens" : "";
  }
  let items;
  if (dialog != null) {
    items = (dialog.files || []).map(function (f) {
      return { label: f.label, desc: util.shortPath(f.path, cwd), sub: f.exists ? [size(f.path), f.description].filter(Boolean).join(" · ") : "not created yet", path: f.exists ? f.path : null };
    }).concat((dialog.folders || []).map(function (f) {
      return { label: f.label, desc: util.shortPath(f.path, cwd), sub: f.description, path: f.path };
    }), (dialog.memories || []).map(function (m) {
      return { label: m.name, desc: m.description || "", sub: [m.type, size(m.path), m.modified_ms ? new Date(m.modified_ms).toLocaleDateString() : ""].filter(Boolean).join(" · "), path: m.path };
    }));
  } else {
    items = loaded.map(function (f) {
      return { label: util.shortPath(f.path, cwd), desc: f.type, sub: size(f.path), path: f.path };
    });
  }
  const auto = dialog && dialog.auto_memory ? "auto memory " + dialog.auto_memory.status : "";
  const b = card.open("brain", "Memory", [loaded.length + " loaded", auto].filter(Boolean).join(" · "));
  card.list(b, items, {
    search: "Filter memory…",
    query: ctx.arg,
    empty: "No memory files",
    action: "open",
    onPick: function (it) {
      if (it.path != null) {
        CC.Commands.open(it.path);
      } else {
        util.toast(it.label + " does not exist yet");
      }
    },
  });
});
