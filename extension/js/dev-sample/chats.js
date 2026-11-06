// A stand-in for CC.Chats and ChatRuntime with the contract's shape, over the sample conversations. Turns are pretended.
CC.devSample.makeChats = function () {
  const TURN_MS = 3500;
  const chats = CC.devSample.chats();
  const runtimes = new Map();
  const listeners = new Set();
  let newCount = 0;

  function find(id) {
    return chats.find(function (c) {
      return c.id === id;
    }) || null;
  }

  function changed() {
    listeners.forEach(function (fn) {
      fn(rows());
    });
  }

  function rowOf(c) {
    return {
      id: c.id, kind: "chat", title: c.title, cwd: c.path, projectId: c.project, state: c.state, ask: c.ask || null, tool: c.ask != null && c.ask.indexOf("Allow ") === 0 ? "Bash" : c.ask != null ? "AskUserQuestion" : null, now: c.now || null,
      since: null, unread: c.unread === true, updatedAt: null, preview: "", model: c.model, cost: 0, running: [], parentId: null,
    };
  }

  function rows() {
    return chats.map(rowOf);
  }

  function isShown(id) {
    return CC.Shell.panes().some(function (p) {
      return p.chatId === id;
    });
  }

  function makeRuntime(c) {
    const events = new Map();
    function emit(name) {
      (events.get(name) || []).slice().forEach(function (fn) {
        fn();
      });
    }

    function runTurn(liveText, resultHtml) {
      c.state = "busy";
      c.now = liveText;
      c.unread = false;
      c.blocks.push({ k: "live", text: liveText, secs: 0 });
      emit("change");
      changed();
      setTimeout(function () {
        c.blocks = c.blocks.filter(function (b) {
          return b.k !== "live";
        });
        c.blocks.push({ k: "text", html: resultHtml });
        c.state = "idle";
        c.now = null;
        c.unread = !isShown(c.id);
        emit("change");
        changed();
      }, TURN_MS);
    }

    const runtime = {
      id: c.id,
      chat: c,
      // Per chat, never per module: this is what two panes must not share.
      ui: { draft: c.draft || "", open: new Set(), viewed: new Set(), find: false },
      store: { get blocks() { return c.blocks; } },
      status: function () {
        return c.state;
      },
      meta: function () {
        return { model: c.model, effort: c.effort, permissionMode: c.mode, cwd: c.path, branch: c.branch };
      },
      on: function (name, fn) {
        if (!events.has(name)) {
          events.set(name, []);
        }
        events.get(name).push(fn);
        return function () {
          const list = events.get(name);
          list.splice(list.indexOf(fn), 1);
        };
      },
      emit: emit,
      send: function (entry) {
        const text = (entry.text || "").trim();
        if (text === "") {
          return;
        }
        if (c.blocks.length === 0) {
          c.title = text.slice(0, 48);
        }
        c.blocks.push({ k: "prompt", text: text, time: "Just now" });
        runTurn("Thinking", "<p>This is a sample reply. This sample isn't connected to Claude.</p>");
      },
      interrupt: function () {},
      respond: function (requestId, behavior) {
        const i = c.blocks.findIndex(function (b) {
          return b.k === "permission" || b.k === "question";
        });
        if (i < 0) {
          return;
        }
        const block = c.blocks[i];
        const option = block.options.find(function (o) {
          return o.key === behavior;
        });
        c.blocks[i] = { k: "answered", q: block.q, a: option.title };
        c.ask = null;
        if (behavior === "deny") {
          c.state = "idle";
          emit("change");
          changed();
          return;
        }
        runTurn(c.resume.live, c.resume.result);
      },
      control: function () {
        return Promise.resolve({});
      },
      stop: function () {},
      restart: function () {},
      loadOlder: function () {},
      toTerminal: function () {},
      toChat: function () {},
      mode: function () {
        return "chat";
      },
      queue: {
        rows: function () {
          return [];
        },
        add: function () {},
        remove: function () {},
        pause: function () {},
        on: function () {
          return function () {};
        },
      },
      dispose: function () {},
    };
    return runtime;
  }

  function open(id) {
    const c = find(id);
    if (c == null) {
      return null;
    }
    if (!runtimes.has(id)) {
      runtimes.set(id, makeRuntime(c));
    }
    return runtimes.get(id);
  }

  return {
    rows: rows,
    on: function (fn) {
      listeners.add(fn);
      return function () {
        listeners.delete(fn);
      };
    },
    get: function (id) {
      const c = find(id);
      return c != null ? rowOf(c) : null;
    },
    open: open,
    create: function () {
      newCount += 1;
      const c = {
        id: "new" + newCount, title: "New chat", project: "orbit", state: "idle", branch: "master", path: "~/projects/orbit", ctx: [0, 200],
        changes: [0, 0, 0], model: "Opus 5.5", effort: "High", mode: "Ask", blocks: [],
      };
      chats.unshift(c);
      changed();
      return Promise.resolve(c.id);
    },
    close: function () {},
    rename: function (id, title) {
      find(id).title = title;
      changed();
    },
    markRead: function (id) {
      find(id).unread = false;
      changed();
    },
    answer: function (id, requestId, behavior) {
      open(id).respond(requestId, behavior);
    },
  };
};
