// What a server offers, decided by one POSIX shell line. Runs on pages and in runScript scripts, which have no window.
(function (root) {
  const CC = root.CC = root.CC || {};
  const MIN_CLAUDE = "2.1.295";
  const MIN_PYTHON = "3.9";

  // Each candidate only runs after a check: on a Mac, /usr/bin/python3 without Xcode tools opens an install dialog.
  const SHELL = [
    'c=$(command -v claude 2>/dev/null)',
    'for f in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do if [ -z "$c" ] && [ -x "$f" ]; then c=$f; fi; done',
    // A script handing `claude` to a Lima VM runs Claude there, while this server's daemon, transcripts and folders stay here: as no Claude on this server.
    'case "$(head -c 4096 "$c" 2>/dev/null)" in *"limactl shell"*) c="";; esac',
    'cv=""',
    'if [ -n "$c" ]; then cv=$("$c" --version 2>/dev/null | head -n 1); fi',
    'p=""',
    'pv=""',
    'for n in python3 python3.13 python3.12 python3.11 python3.10 python3.9; do ' +
      'q=$(command -v "$n" 2>/dev/null); ' +
      'if [ -z "$q" ]; then continue; fi; ' +
      'if [ "$q" = /usr/bin/python3 ] && [ "$(uname)" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then continue; fi; ' +
      'v=$("$q" -c \'import sys; print("%d.%d.%d" % sys.version_info[:3]); sys.exit(sys.version_info < (' + MIN_PYTHON.replace(".", ",") + '))\' 2>/dev/null) || continue; ' +
      'p=$q; pv=$v; break; ' +
    'done',
    // Which projects are this server's, the only way to tell servers apart, before any Python and in the same line, so no consent prompt of its own.
    'ids=""',
    'm=$(command -v muxy 2>/dev/null)',
    'if [ -z "$m" ]; then m=$HOME/.local/bin/muxy; fi',
    'if [ -x "$m" ]; then ids=$("$m" project list --json 2>/dev/null | tr -d "\\n"); fi',
    'printf "claude=%s\\nclaudeVersion=%s\\npython=%s\\npythonVersion=%s\\nhost=%s\\nsystem=%s\\nprojects=%s\\n" "$c" "$cv" "$p" "$pv" "$(uname -n)" "$(uname -s)" "$ids"',
  ].join("; ");

  function older(a, b) {
    const x = a.split(".").map(Number);
    const y = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((x[i] || 0) !== (y[i] || 0)) {
        return (x[i] || 0) < (y[i] || 0);
      }
    }
    return false;
  }

  function projectIds(text) {
    try {
      const rows = JSON.parse(text);
      return Array.isArray(rows) ? rows.map(function (r) {
        return String(r.id);
      }) : null;
    } catch (e) {
      return null;
    }
  }

  function parse(stdout) {
    const f = {};
    String(stdout).split("\n").forEach(function (line) {
      const at = line.indexOf("=");
      if (at > 0) {
        f[line.slice(0, at)] = line.slice(at + 1).trim();
      }
    });
    const claudeVersion = /\d+\.\d+\.\d+/.exec(f.claudeVersion || "");
    const claude = f.claude ? { path: f.claude, version: claudeVersion != null ? claudeVersion[0] : null } : null;
    const python = f.python ? { path: f.python, version: f.pythonVersion || null } : null;
    let missing = null;
    if (claude == null) {
      missing = "claude";
    } else if (python == null) {
      missing = "python";
    } else if (claude.version == null || older(claude.version, MIN_CLAUDE)) {
      missing = "claude-version";
    }
    return { experience: missing == null ? "chat" : "terminal", missing: missing, claude: claude, python: python,
      host: (f.host || "").split(".")[0] || null, system: f.system || null, ids: projectIds(f.projects) };
  }

  // A server where chats can't start at all. The page then starts no Python and installs nothing: list and terminals only. An old Claude isn't this: Python is there.
  function noChats(result) {
    return result != null && (result.missing === "claude" || result.missing === "python");
  }

  // Whether the server with these project ids is this computer. projects: projects.list(), whose first is always this computer's Home. Without a
  // catalog: a project at or under that Home. Null when that can't be said.
  function isLocal(ids, projects, project) {
    const home = (projects || [])[0];
    if (home == null) {
      return null;
    }
    if (ids != null) {
      return ids.map(String).indexOf(String(home.id)) >= 0;
    }
    if (project == null) {
      return null;
    }
    const root = String(home.path || "").replace(/\/+$/, "");
    const path = String(project.path || "");
    return String(project.id) === String(home.id) || (root !== "" && (path === root || path.indexOf(root + "/") === 0));
  }

  // The toast for a server that can't run chats. Null when nothing should be said: no Claude Code is a plain terminal user.
  function message(result) {
    if (result.missing === "python") {
      return "Claude Chat needs Python " + MIN_PYTHON + " or newer on this server, so this opens a terminal.";
    }
    if (result.missing === "claude-version") {
      return "Claude Chat needs Claude Code " + MIN_CLAUDE + " or newer on this server, so this opens a terminal.";
    }
    return null;
  }

  // The sidebar's line, where the list and terminals are already on screen. No Claude Code says nothing: nobody has to want it.
  function note(result) {
    if (result.missing === "python") {
      return "Chats need Python " + MIN_PYTHON + " or newer on this server. The list and terminals work without it.";
    }
    return result.missing === "claude" ? null : message(result);
  }

  CC.probeCore = { SHELL: SHELL, MIN_CLAUDE: MIN_CLAUDE, MIN_PYTHON: MIN_PYTHON, parse: parse, message: message, note: note, noChats: noChats, isLocal: isLocal };
})(typeof globalThis !== "undefined" ? globalThis : this);
