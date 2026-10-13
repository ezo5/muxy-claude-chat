window.CC = window.CC || {};

CC.BUILTIN_COMMANDS = [
  ["clear", "Start a new conversation (clear history)"],
  ["compact", "Compact the conversation, optionally with focus instructions", "[instructions]"],
  ["model", "Switch the model", "[model]", false, true],
  ["effort", "Set reasoning effort", "[low|medium|high|xhigh|max]", false, true],
  ["context", "Show context window usage"],
  ["cost", "Show cost and duration of this session"],
  ["usage", "Show plan usage limits", "", true],
  ["status", "Show version, model, account and connectivity", "", true],
  ["resume", "Resume an earlier conversation", "[session]", false, true],
  ["rewind", "Rewind the conversation and/or code", "", true],
  ["init", "Create a CLAUDE.md for this project"],
  ["memory", "Edit memory files", "", true],
  ["review", "Review a pull request", "[pr]"],
  ["security-review", "Security review of pending changes"],
  ["add-dir", "Add a working directory", "<path>"],
  ["agents", "Manage subagents", "", true],
  ["mcp", "Manage MCP servers", "", true],
  ["hooks", "Manage hooks", "", true],
  ["permissions", "View or update permission rules", "", true],
  ["config", "Open settings", "", true],
  ["plugin", "Manage plugins", "", true],
  ["output-style", "Set the output style", "[style]", true],
  ["todos", "Show the current todo list"],
  ["bashes", "List background tasks", "", true],
  ["export", "Export the conversation", "[file]", true],
  ["plan", "Enter plan mode", "[prompt]"],
  ["fast", "Toggle fast mode"],
  ["ide", "Connect to an IDE", "", true],
  ["doctor", "Diagnose the installation", "", true],
  ["release-notes", "Show release notes", "", true],
  ["help", "Show help", "", true],
  ["exit", "Stop Claude in this chat"],
  ["quit", "Stop Claude in this chat"],
].map(function (c) {
  return { name: c[0], desc: c[1], hint: c[2] || "", dialog: c[3] === true, picker: c[4] === true, source: "built-in" };
});

CC.Composer.use(function (composer) {
  const owner = { name: "slash" };
  composer.commands = [];

  const LOCAL = { resume: true, model: true, effort: true };

  // The CLI's initialize reply lists its commands (skills included); the static list is the fallback before it arrives.
  function all() {
    const live = composer.meta.commands;
    if (Array.isArray(live) && live.length > 0) {
      const names = {};
      const out = live.map(function (c) {
        names[c.name] = true;
        return { name: c.name, desc: c.description || "", hint: c.argumentHint || "", picker: LOCAL[c.name] === true, source: "" };
      });
      CC.BUILTIN_COMMANDS.forEach(function (c) {
        if (names[c.name] !== true && (c.picker || c.name === "exit")) {
          out.push(c);
        }
      });
      return out;
    }
    return CC.BUILTIN_COMMANDS.concat(composer.commands);
  }

  function score(name, q) {
    if (q === "") {
      return 1;
    }
    const n = name.toLowerCase();
    if (n.indexOf(q) === 0) {
      return 100 - n.length / 100;
    }
    const tail = n.split(":").pop();
    if (tail.indexOf(q) === 0) {
      return 80 - n.length / 100;
    }
    if (n.indexOf(q) >= 0) {
      return 50 - n.length / 100;
    }
    return 0;
  }

  function token() {
    const v = composer.value();
    const caret = composer.input.selectionStart;
    const m = /^\/(\S*)$/.exec(v.slice(0, caret));
    if (m == null || /\s/.test(v.slice(0, caret)) || (v.length > caret && !/^\s/.test(v.slice(caret)))) {
      return null;
    }
    return m[1].toLowerCase();
  }

  function update(ev) {
    if (ev != null && ev.programmatic === true) {
      if (composer.popup.isOpen(owner)) {
        composer.popup.close();
      }
      return false;
    }
    const q = token();
    if (q == null) {
      if (composer.popup.isOpen(owner)) {
        composer.popup.close();
      }
      return;
    }
    const list = all().map(function (c) {
      return { c: c, s: score(c.name, q) };
    }).filter(function (x) {
      return x.s > 0;
    }).sort(function (a, b) {
      return b.s - a.s;
    }).slice(0, 40).map(function (x) {
      return {
        label: "/" + x.c.name,
        hint: x.c.hint,
        desc: x.c.desc,
        badge: x.c.picker ? "picker" : x.c.source && x.c.source !== "built-in" ? x.c.source : "",
        cmd: x.c,
      };
    });
    composer.popup.open(owner, list, { title: "Commands" });
  }

  // Only a required argument (`<path>`) keeps Enter as completion; `[name]` / `<optional …>` send right away.
  function needsArg(cmd) {
    return /^</.test(cmd.hint || "") && !/optional/i.test(cmd.hint);
  }

  owner.onPick = function (it, how) {
    const rest = composer.value().slice(composer.input.selectionStart).replace(/^\s+/, "");
    composer.setValue("/" + it.cmd.name + " " + rest);
    if (how === "enter" && (!needsArg(it.cmd) || it.cmd.picker) && rest === "") {
      composer.setValue("/" + it.cmd.name);
      composer.submit(false);
    }
  };

  composer.on("input", update);
  composer.input.addEventListener("click", function () {
    update(null);
  });
});
