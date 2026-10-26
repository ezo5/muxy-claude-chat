window.CC = window.CC || {};

// `/permissions`: read-only list_permission_rules (allow, ask, deny with their source) and the permission mode; a pick
// opens the rule's settings file. update_settings refuses `permissions` keys, so rules are edited in the file.
CC.Commands.add(["permissions", "allowed-tools"], async function (ctx) {
  const util = CC.util;
  const el = util.el;
  const card = ctx.card;
  const composer = ctx.composer;
  const SOURCES = {
    userSettings: "user settings", projectSettings: "project settings", localSettings: "local settings",
    policySettings: "managed policy", flagSettings: "--settings flag", cliArg: "command-line flag", command: "slash command", session: "this session",
  };
  const ORDER = ["allow", "ask", "deny"];
  const body = card.open("shield", "Permissions");
  body.appendChild(el("div", "picker-empty", "Loading…"));
  card.hints([]);
  let r;
  try {
    r = await CC.Commands.control(composer, "list_permission_rules");
  } catch (e) {
    body.textContent = "";
    body.appendChild(el("div", "picker-empty", "Permission rules unavailable: " + e.message));
    return;
  }
  if (!card.root.contains(body)) {
    return;
  }
  const st = r.state || {};
  const rules = (st.rules || []).slice().sort(function (a, b) {
    return ORDER.indexOf(a.behavior) - ORDER.indexOf(b.behavior);
  });
  const counts = ORDER.map(function (k) {
    return rules.filter(function (x) {
      return x.behavior === k;
    }).length + " " + k;
  }).join(" · ");
  const b = card.open("shield", "Permissions", counts);
  card.rows(b, [
    ["Mode", composer.meta.permissionMode],
    ["Directories", [st.originalCwd || composer.meta.cwd].concat((st.workspaceDirectories || []).map(function (d) {
      return d.path || d;
    })).filter(Boolean).join(", ")],
  ].concat(st.managedOnly ? [["Policy", "only managed rules apply"]] : []));
  card.list(b, rules.map(function (x) {
    const d = x.description;
    return {
      label: x.rule,
      dot: { allow: "ok", ask: "mid", deny: "err" }[x.behavior],
      desc: d ? d.prefix + (d.emphasis || "") + (d.suffix || "") : "",
      sub: x.behavior + " · " + (SOURCES[x.source] || x.source),
      path: CC.Commands.settingsFile(composer, x.source),
    };
  }), {
    search: "Filter rules…",
    query: ctx.arg,
    empty: "No permission rules",
    action: "open settings file",
    onPick: function (it) {
      if (it.path != null) {
        CC.Commands.open(it.path);
      } else {
        util.toast("This rule has no settings file to open");
      }
    },
  });
});
