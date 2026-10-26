window.CC = window.CC || {};

// `/status`: version, model, account, session and MCP servers. Account comes from the initialize reply, the
// version and MCP state from get_binary_version / mcp_status (need a running CLI).
CC.Commands.add("status", function (ctx) {
  const util = CC.util;
  const el = util.el;
  const composer = ctx.composer;
  const card = ctx.card;
  const m = composer.meta;
  const acc = m.account || {};
  const body = card.open("gear", "Status");
  const version = el("span", null, m.cliVersion || "…");
  const mcp = el("span", null, "…");
  card.rows(body, [
    ["Claude Code", version],
    ["Model", m.model ? m.model + (m.modelId && m.modelId !== m.model ? " (" + m.modelId + ")" : "") : m.modelId],
    ["Effort", m.effort],
    ["Permission mode", m.permissionMode],
    ["Account", acc.email],
    ["Organization", acc.organization],
    ["Plan", acc.subscriptionType],
    ["API provider", acc.apiProvider],
    ["Working directory", m.cwd],
    ["Session", composer.deps.sessionId()],
    ["MCP servers", mcp],
  ]);
  const servers = el("div", "cmd-list");
  body.appendChild(servers);
  card.hints([]);
  const root = card.root;

  CC.Commands.control(composer, "get_binary_version").then(function (r) {
    version.textContent = (r.version || m.cliVersion || "—") + (r.buildTime ? " · built " + new Date(r.buildTime).toLocaleDateString() : "");
  }, function () {
    version.textContent = m.cliVersion || "—";
  });
  CC.Commands.control(composer, "mcp_status").then(function (r) {
    if (!root.contains(mcp)) {
      return;
    }
    const list = r.mcpServers || [];
    const counts = {};
    list.forEach(function (s) {
      counts[s.status] = (counts[s.status] || 0) + 1;
    });
    mcp.textContent = list.length === 0 ? "none" : list.length + " · " + Object.keys(counts).map(function (k) {
      return counts[k] + " " + k;
    }).join(", ");
    list.forEach(function (s) {
      const row = el("div", "cmd-item");
      row.appendChild(el("span", "cmd-dot cmd-" + (s.status === "connected" ? "ok" : s.status === "failed" ? "err" : "mid")));
      row.appendChild(el("span", "cmd-item-name", s.name));
      row.appendChild(el("span", "cmd-item-meta", s.status + (Array.isArray(s.tools) ? " · " + s.tools.length + " tools" : "")));
      servers.appendChild(row);
    });
  }, function (e) {
    mcp.textContent = "unavailable (" + e.message + ")";
  });
});
