// ?sample=1 chats have hand-written blocks instead of a Store. This turns them into store items, so the sample shows the real flow.
CC.conversationSample = (function () {
  const facades = new WeakMap();

  function htmlToText(html) {
    return String(html || "").replace(/<code>(.*?)<\/code>/g, "`$1`").replace(/<\/p>\s*/g, "\n\n").replace(/<li>/g, "- ").replace(/<\/li>\s*/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  }

  function toolItems(r, id) {
    // Output without a file name is a command's: path holds the command line.
    if (r.code != null && r.name == null) {
      return [{ k: "tool", id: id, name: "Bash", input: { description: r.label, command: r.path } },
        { k: "result", tid: id, text: r.code.join("\n"), err: r.failed === true }];
    }
    if (r.code != null) {
      return [{ k: "tool", id: id, name: "Read", input: { file_path: r.path } },
        { k: "result", tid: id, text: r.code.map(function (t, i) {
          return (r.from + i) + "\t" + t;
        }).join("\n") }];
    }
    if (r.diff != null) {
      const first = r.diff.length > 0 ? r.diff[0][1] : 1;
      return [{ k: "tool", id: id, name: "Edit", input: { file_path: r.path } },
        { k: "result", tid: id, text: "", extra: { patch: [{ oldStart: first, newStart: first, lines: r.diff.map(function (l) {
          return l[0] + l[2];
        }) }] } }];
    }
    return [{ k: "tool", id: id, name: "Bash", input: { description: r.label, command: "" } }, { k: "result", tid: id, text: "", err: r.failed === true }];
  }

  function items(blocks) {
    const out = [];
    let tasks = null;
    blocks.forEach(function (b, i) {
      const id = "sample-" + i;
      if (b.k === "prompt") {
        out.push({ k: "user", id: id, text: b.text });
      } else if (b.k === "text") {
        out.push({ k: "text", id: id, text: htmlToText(b.html) });
      } else if (b.k === "work") {
        b.rows.forEach(function (r, j) {
          toolItems(r, id + ":" + j).forEach(function (it) {
            out.push(it);
          });
        });
      } else if (b.k === "tasks") {
        tasks = { k: "tool", id: id, name: "TodoWrite", input: { todos: b.items.map(function (t) {
          return { content: t[1], status: t[0] === "done" ? "completed" : t[0] === "run" ? "in_progress" : "pending" };
        }) } };
        out.push(tasks);
      } else if (b.k === "end") {
        out.push({ k: "turn", id: id, ms: 0 });
      }
    });
    return out;
  }

  // A runtime with a Store, over a sample chat. Kept per sample runtime so two panes of one chat share it.
  function adapt(runtime) {
    if (runtime == null || (runtime.store != null && typeof runtime.store.on === "function")) {
      return runtime;
    }
    let facade = facades.get(runtime);
    if (facade != null) {
      return facade;
    }
    const store = new CC.Store();
    function sync() {
      store.reset();
      store.add(items(runtime.store.blocks));
      const live = runtime.store.blocks.find(function (b) {
        return b.k === "live";
      });
      store.setMeta({ cwd: runtime.meta().cwd, turn: live != null ? { startedAt: Date.now() - (live.secs || 0) * 1000 } : null });
      store.setStatus(live != null || runtime.status() === "busy" ? "busy" : "idle");
    }
    runtime.on("change", sync);
    sync();
    facade = { id: runtime.id, store: store, on: function (n, fn) { return store.on(n, fn); }, loadOlder: function () { return Promise.resolve(); }, meta: function () { return store.meta; }, status: function () { return store.status; } };
    facades.set(runtime, facade);
    return facade;
  }

  return { adapt: adapt };
})();
