// `/hooks`: read-only get_hooks_listing (settings, session and plugin hooks in event order); a pick opens the
// settings file a hook comes from.
CC.Commands.add("hooks", async function (ctx) {
  const runtime = ctx.runtime;
  const util = CC.util;
  const el = util.el;
  const card = ctx.card;
  const body = card.open("terminal", "Hooks");
  body.appendChild(el("div", "cc-cmd-empty", "Loading…"));
  card.hints([]);
  let r;
  try {
    r = await CC.Commands.control(runtime, "get_hooks_listing");
  } catch (e) {
    body.textContent = "";
    body.appendChild(el("div", "cc-cmd-empty", "Hooks unavailable: " + e.message));
    return;
  }
  if (!card.root.contains(body)) {
    return;
  }
  const hooks = r.hooks || [];
  const order = (r.eventCatalog || r.events || []).map(function (ev) {
    return ev.name;
  });
  hooks.sort(function (a, b) {
    return order.indexOf(a.event) - order.indexOf(b.event);
  });
  const b = card.open("terminal", "Hooks", hooks.length + " configured");
  const policy = r.policy || {};
  if (policy.allDisabled || policy.disabledByPolicy) {
    b.appendChild(el("div", "cc-cmd-note", "Hooks are disabled" + (policy.disabledByPolicy ? " by policy." : " (disableAllHooks).")));
  } else if (policy.managedOnly || policy.pluginOnly) {
    b.appendChild(el("div", "cc-cmd-note", "Only " + (policy.managedOnly ? "managed" : "plugin") + " hooks run."));
  }
  card.list(b, hooks.map(function (h) {
    return {
      label: h.event + (h.matcher ? " · " + h.matcher : ""),
      desc: util.firstLine(h.displayText || h.commandText, 200),
      sub: (h.sourceLabel || h.source || "") + (h.timeout ? " · timeout " + h.timeout + " s" : ""),
      title: h.commandText || h.displayText,
      path: CC.Commands.settingsFile(runtime, h.source),
    };
  }), {
    search: "Filter hooks",
    query: ctx.arg,
    empty: "No hooks configured",
    action: "open settings file",
    onPick: function (it) {
      if (it.path != null) {
        CC.Commands.open(runtime, it.path);
      } else {
        CC.Commands.toast("This hook has no settings file to open");
      }
    },
  });
});
