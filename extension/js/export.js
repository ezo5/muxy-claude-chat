window.CC = window.CC || {};

// Conversation → Markdown from the store items: prompts and answers in full, tools as one line each.
CC.exportMarkdown = (function () {
  const util = CC.util;
  const ARG_KEYS = ["command", "file_path", "notebook_path", "path", "pattern", "url", "query", "description", "skill", "prompt"];

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

  return function (store, opts) {
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
      } else if (it.k === "notice") {
        block(speaker || "Claude", "> " + util.firstLine(it.text, 300));
      }
    });
    return out.join("\n") + "\n";
  };
})();
