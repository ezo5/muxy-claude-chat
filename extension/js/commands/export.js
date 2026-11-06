// `/export`: the conversation as Markdown from the store items: prompts and answers in full, tools as one line each. The webview blocks downloads,
// so the file goes next to the project on the server.
CC.Export = (function () {
  const util = CC.util;
  const ARG_KEYS = ["command", "file_path", "notebook_path", "path", "pattern", "url", "query", "description", "skill", "prompt"];
  const CHUNK = 200000;

  function toolLine(item, store, cwd) {
    const input = item.input || {};
    const key = ARG_KEYS.find(function (k) {
      return typeof input[k] === "string" && input[k] !== "";
    });
    let arg = key != null ? util.firstLine(input[key], 120) : "";
    if (/path$/.test(key || "")) {
      arg = util.shortPath(arg, cwd);
    }
    const r = store.resultOf(item.id);
    return "- `" + item.name + "`" + (arg ? " " + arg.replace(/`/g, "'") : "") + (r != null && r.err ? " (failed)" : "");
  }

  function markdown(store, opts) {
    const out = ["# " + opts.title, "", "_" + [opts.cwd, "exported " + new Date().toLocaleString()].filter(Boolean).join(" · ") + "_"];
    let speaker = null;
    function block(who, text) {
      if (who !== speaker) {
        out.push("", "## " + who);
        speaker = who;
      }
      out.push("", text);
    }
    store.items.forEach(function (it) {
      if (it.agent != null || it.partial === true) {
        return;
      }
      if (it.k === "user") {
        speaker = null;
        block("You", it.command ? "`" + it.text + "`" : it.text + (it.images ? "\n\n_(" + it.images + (it.images === 1 ? " image)_" : " images)_") : ""));
      } else if (it.k === "text") {
        block("Claude", it.text);
      } else if (it.k === "tool") {
        const line = toolLine(it, store, opts.cwd);
        if (speaker === "Claude" && /^- `/.test(out[out.length - 1])) {
          out.push(line);
        } else {
          block("Claude", line);
        }
      } else if (it.k === "notice" && it.level === "handback") {
        block("Claude", "> " + (it.text || "Subagent") + " report:\n\n" + it.detail);
      } else if (it.k === "notice") {
        block(speaker || "Claude", "> " + util.firstLine(it.text, 300));
      }
    });
    return out.join("\n") + "\n";
  }

  function fileName() {
    const d = new Date();
    const pad = function (n) {
      return String(n).padStart(2, "0");
    };
    return "claude-chat-export-" + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + ".md";
  }

  async function run(runtime) {
    const cwd = CC.Commands.cwdOf(runtime);
    try {
      for (let i = 0; runtime.store.hasOlder && i < 200; i++) {
        await runtime.loadOlder();
      }
      const row = CC.Chats != null ? CC.Chats.get(runtime.id) : null;
      const text = markdown(runtime.store, { title: (row != null && row.title) || runtime.meta().title || "Chat", cwd: cwd });
      const name = fileName();
      let res = null;
      for (let i = 0; i < text.length; i += CHUNK) {
        res = await CC.Servers.of(runtime).host.call("writeExport", { cwd: cwd, name: name, text: text.slice(i, i + CHUNK), append: i > 0 });
      }
      CC.Commands.toast("Exported to " + res.path);
    } catch (e) {
      CC.Commands.toast("Export failed: " + CC.Commands.message(e), "error");
    }
  }

  return { markdown: markdown, run: run };
})();

CC.Commands.add("export", function (ctx) {
  return CC.Export.run(ctx.runtime);
});
