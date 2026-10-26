window.CC = window.CC || {};

// `/doctor`: local diagnostics (reader `doctor`: binary, installs, settings files; get_binary_version, get_settings,
// mcp_status, account, daemon). The CLI's own /doctor is a skill that works headless; a button sends it as a prompt.
CC.Commands.add("doctor", async function (ctx) {
  const util = CC.util;
  const el = util.el;
  const composer = ctx.composer;
  const card = ctx.card;
  const m = composer.meta;
  const acc = m.account || {};
  const daemon = m.daemon || {};
  const body = card.open("wrench", "Doctor");
  const root = card.root;

  function dot(level, text) {
    const s = el("span", "cmd-item");
    s.appendChild(el("span", "cmd-dot cmd-" + level));
    s.appendChild(el("span", null, text));
    return s;
  }

  const version = el("span", null, "…");
  const binary = el("span", null, "…");
  const settings = el("span", null, "…");
  const mcp = el("span", null, "…");
  card.rows(body, [
    ["Claude Code", version],
    ["Binary", binary],
    ["Settings", settings],
    ["MCP servers", mcp],
    ["Account", acc.email ? dot("ok", acc.email + (acc.subscriptionType ? " · " + acc.subscriptionType : "")) : dot("mid", "unknown (no initialize reply yet)")],
    ["Daemon", dot(composer.status === "error" || composer.status === "stopped" ? "err" : composer.status === "idle" || composer.isWorking() ? "ok" : "mid",
      composer.status + (daemon.pid ? " · pid " + daemon.pid : "") + (daemon.resumed ? " · resumed" : ""))],
    ["Working directory", m.cwd],
  ]);
  const issues = el("div", "cmd-list");
  body.appendChild(issues);
  body.appendChild(el("div", "cmd-note", "The full health check (installs, unused skills and MCP servers, memory files, slow hooks, permissions) is "
    + "Claude Code's /doctor skill: it runs as a normal prompt and asks before changing anything."));
  const actions = el("div", "cmd-actions");
  const run = el("button", "chip-btn primary", "Run /doctor health check");
  run.type = "button";
  run.addEventListener("click", function () {
    card.close();
    composer.dispatch({ id: util.uid(), text: "/doctor", images: [], previews: [], createdAt: Date.now() }, false);
  });
  actions.appendChild(run);
  body.appendChild(actions);
  card.hints([]);

  function issue(level, text) {
    const row = el("div", "cmd-item");
    row.appendChild(el("span", "cmd-dot cmd-" + level));
    row.appendChild(el("span", "cmd-item-name", text));
    row.title = text;
    issues.appendChild(row);
  }

  CC.Commands.control(composer, "get_binary_version").then(function (r) {
    version.replaceWith(dot("ok", (r.version || m.cliVersion || "—") + (r.buildTime ? " · built " + new Date(r.buildTime).toLocaleDateString() : "")));
  }, function (e) {
    version.replaceWith(dot("err", (m.cliVersion || "unknown") + " (CLI not answering: " + e.message + ")"));
  });

  CC.host.reader("doctor", { cwd: m.cwd }).then(function (r) {
    if (!root.contains(binary)) {
      return;
    }
    binary.replaceWith(r.binary ? dot("ok", r.binary + (r.real && r.real !== r.binary ? " → " + r.real : "") + " (" + r.type + ")") : dot("err", "claude not found (PATH, ~/.local/bin/claude or config claudeBin)"));
    const others = (r.installs || []).filter(function (i) {
      return i.real !== r.real;
    });
    if (others.length > 0) {
      issue("mid", "Other installs: " + others.map(function (i) {
        return i.path + " (" + i.type + ")";
      }).join(", "));
    }
    const files = (r.settings || []).filter(function (s) {
      return s.exists;
    });
    const bad = files.filter(function (s) {
      return !s.ok;
    });
    settings.replaceWith(dot(bad.length > 0 ? "err" : "ok", bad.length > 0 ? bad.length + " invalid of " + files.length + " files" : files.length + " files parse"));
    bad.forEach(function (s) {
      issue("err", util.shortPath(s.path) + ": " + s.error);
    });
    files.filter(function (s) {
      return s.ok;
    }).forEach(function (s) {
      issue("ok", util.shortPath(s.path));
    });
  }, function (e) {
    binary.replaceWith(dot("mid", "unavailable (" + e.message + ")"));
  });

  CC.Commands.control(composer, "get_settings").then(function (r) {
    const names = (r.sources || []).map(function (s) {
      return s.source;
    });
    issue("ok", "Loaded by the CLI: " + (names.length > 0 ? names.join(", ") : "defaults only"));
  }, function (e) {
    issue("err", "Effective settings unavailable: " + e.message);
  });

  CC.Commands.control(composer, "mcp_status").then(function (r) {
    const list = r.mcpServers || [];
    const failed = list.filter(function (s) {
      return s.status === "failed";
    });
    const pending = list.filter(function (s) {
      return s.status !== "failed" && s.status !== "connected";
    });
    mcp.replaceWith(dot(failed.length > 0 ? "err" : pending.length > 0 ? "mid" : "ok", list.length === 0 ? "none"
      : list.length + " · " + (list.length - failed.length - pending.length) + " connected" + (failed.length > 0 ? ", " + failed.length + " failed" : "")
      + (pending.length > 0 ? ", " + pending.length + " other" : "")));
    failed.forEach(function (s) {
      issue("err", "MCP " + s.name + " failed" + (s.error ? ": " + s.error : ""));
    });
  }, function (e) {
    mcp.replaceWith(dot("mid", "unavailable (" + e.message + ")"));
  });
});
