window.CC = window.CC || {};

// `/mcp [reconnect|enable|disable <server>|all]`: servers from mcp_status; a pick shows one with Reconnect
// (mcp_reconnect) and Enable / Disable (mcp_toggle, persisted like the TUI's). Enabling and reconnecting wait for the
// connection, the CLI gives up after 30 s.
CC.Commands.add("mcp", function (ctx) {
  const util = CC.util;
  const el = util.el;
  const card = ctx.card;
  const composer = ctx.composer;

  function dot(status) {
    return status === "connected" ? "ok" : status === "failed" ? "err" : status === "disabled" ? "off" : "mid";
  }

  function message(text) {
    const body = card.open("globe", "MCP servers");
    body.appendChild(el("div", "picker-empty", text));
    card.hints([]);
    return body;
  }

  async function list() {
    const body = message("Loading…");
    let r;
    try {
      r = await CC.Commands.control(composer, "mcp_status");
    } catch (e) {
      if (card.root.contains(body)) {
        message("MCP status unavailable: " + e.message);
      }
      return;
    }
    if (!card.root.contains(body)) {
      return;
    }
    const servers = r.mcpServers || [];
    const b = card.open("globe", "MCP servers", servers.length + " configured");
    card.list(b, servers.map(function (s) {
      const tools = Array.isArray(s.tools) ? s.tools.length + " tools" : "";
      return { label: s.name, dot: dot(s.status), desc: s.error || "", sub: [s.status, s.scope, tools].filter(Boolean).join(" · "), server: s };
    }), {
      search: servers.length > 8 ? "Filter servers…" : null,
      empty: "No MCP servers configured",
      action: "manage",
      onPick: function (it) {
        detail(it.server);
      },
    });
  }

  function button(text, primary, run) {
    const b = el("button", "chip-btn" + (primary ? " primary" : ""), text);
    b.type = "button";
    b.addEventListener("click", run);
    return b;
  }

  function detail(s) {
    const cfg = s.config || {};
    const body = card.open("globe", s.name, s.status);
    card.rows(body, [
      ["Status", s.status],
      ["Scope", s.scope],
      ["Transport", cfg.type],
      ["Endpoint", cfg.url || [cfg.command].concat(cfg.args || []).filter(Boolean).join(" ")],
      ["Server", s.serverInfo ? (s.serverInfo.title || s.serverInfo.name) + (s.serverInfo.version ? " " + s.serverInfo.version : "") : null],
      ["Tools", Array.isArray(s.tools) ? s.tools.map(function (t) {
        return t.name;
      }).join(", ") || "none" : null],
      ["Error", s.error],
    ]);
    const actions = el("div", "cmd-actions");
    const off = s.status === "disabled";
    actions.appendChild(button("Back", false, list));
    actions.appendChild(button(off ? "Enable" : "Disable", off, function () {
      act(s, off ? "Enabling" : "Disabling", "mcp_toggle", { enabled: off });
    }));
    if (!off) {
      actions.appendChild(button("Reconnect", true, function () {
        act(s, "Reconnecting", "mcp_reconnect", {});
      }));
    }
    body.appendChild(actions);
    card.hints([]);
    actions.lastChild.focus();
  }

  async function act(s, label, subtype, payload) {
    const body = message(label + " " + s.name + "…");
    await run(s.name, subtype, payload);
    if (card.root.contains(body)) {
      list();
    }
  }

  function run(name, subtype, payload) {
    return CC.Commands.control(composer, subtype, Object.assign({ serverName: name }, payload)).catch(function (e) {
      util.toast(name + ": " + e.message, "error");
    });
  }

  async function command(verb, target) {
    const subtype = verb === "reconnect" ? "mcp_reconnect" : "mcp_toggle";
    const payload = verb === "reconnect" ? {} : { enabled: verb === "enable" };
    const body = message((verb === "reconnect" ? "Reconnecting " : verb === "enable" ? "Enabling " : "Disabling ") + target + "…");
    let names = [target];
    if (target === "all") {
      const r = await CC.Commands.control(composer, "mcp_status").catch(function () {
        return {};
      });
      names = (r.mcpServers || []).filter(function (s) {
        return verb === "enable" ? s.status === "disabled" : s.status !== "disabled";
      }).map(function (s) {
        return s.name;
      });
    }
    await Promise.all(names.map(function (n) {
      return run(n, subtype, payload);
    }));
    if (card.root.contains(body)) {
      list();
    }
  }

  const m = /^(reconnect|enable|disable)\s+(.+)$/.exec(ctx.arg);
  if (m != null) {
    command(m[1], m[2].trim());
  } else {
    list();
  }
});
