// `/status`: version, model, account, session and MCP servers. Account comes from the initialize reply, the
// version and MCP state from get_binary_version / mcp_status (need a running CLI).
CC.Commands.add("status", function (ctx) {
  const runtime = ctx.runtime;
  const util = CC.util;
  const el = util.el;
  const card = ctx.card;
  const m = runtime.meta();
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
    ["Session", runtime.meta().cliSessionId || runtime.id],
    ["MCP servers", mcp],
  ]);
  const servers = el("div", "cc-cmd-list");
  body.appendChild(servers);
  card.hints([]);
  const root = card.root;

  CC.Commands.control(runtime, "get_binary_version").then(function (r) {
    version.textContent = (r.version || m.cliVersion || "—") + (r.buildTime ? " · built " + new Date(r.buildTime).toLocaleDateString() : "");
  }, function () {
    version.textContent = m.cliVersion || "—";
  });
  CC.Commands.control(runtime, "mcp_status").then(function (r) {
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
      const row = el("div", "cc-cmd-item");
      row.appendChild(el("span", "cc-cmd-dot is-" + (s.status === "connected" ? "ok" : s.status === "failed" ? "err" : "mid")));
      row.appendChild(el("span", "cc-cmd-item-name", s.name));
      row.appendChild(el("span", "cc-cmd-item-meta", s.status + (Array.isArray(s.tools) ? " · " + s.tools.length + " tools" : "")));
      servers.appendChild(row);
    });
  }, function (e) {
    mcp.textContent = "unavailable (" + e.message + ")";
  });
});
