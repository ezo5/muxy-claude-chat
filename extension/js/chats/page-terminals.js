// Terminals drawn in the page with xterm.js, on any server, so a terminal doesn't take you out of the app. server/ptyhost.py on that server holds the shells, so they outlive a
// reload and a closed pane; the list here is what they say. A row looks like a Muxy terminal's, "pane:<id>", and only going to it and closing it differ.
CC.PageTerminals = (function () {
  const PREFIX = "term-";
  const CALL_MS = 10000;
  let known = [];
  const listed = new Set();
  const titles = new Map();
  const fns = new Set();

  function notify() {
    fns.forEach(function (fn) {
      fn();
    });
  }

  // Null where this can't run: a page without the direct route, or no usable Python, which the probe looked for without setting off a Mac's install dialog.
  async function pythonOf(s) {
    if (s == null || s.host == null || s.host.pty == null) {
      return null;
    }
    const found = await s.host.probe();
    return found != null && found.python != null ? found.python.path : null;
  }

  // key: the server's, also of one not found yet, as a pane comes back before the servers do. That failure says `waiting`.
  async function call(key, request, timeoutMs) {
    const s = CC.Servers.get(key);
    const python = await pythonOf(s);
    if (python == null) {
      const e = new Error("Terminals need Python on this server");
      e.waiting = s == null;
      throw e;
    }
    return s.host.pty(python, request, timeoutMs != null ? timeoutMs : CALL_MS);
  }

  async function read(s) {
    const answer = await call(s.key, { op: "list" });
    known = known.filter(function (t) {
      return t.server !== s.key;
    }).concat((answer.terminals || []).map(function (t) {
      return { id: t.id, cwd: t.cwd, project: t.project, server: s.key };
    }));
    notify();
    return known;
  }

  // The shells left from before this page, once per server that answers.
  function start() {
    function look() {
      CC.Servers.list().forEach(function (s) {
        if (!listed.has(s.key) && s.state === "up" && s.host != null && s.host.pty != null) {
          listed.add(s.key);
          pythonOf(s).then(function (python) {
            return python != null ? read(s) : null;
          }).catch(function (e) {
            listed.delete(s.key);
            console.warn("page terminals not read", e && e.message);
          });
        }
      });
    }
    CC.Servers.on(look);
    look();
  }

  function owns(paneId) {
    return String(paneId).indexOf(PREFIX) === 0;
  }

  function entry(id) {
    return known.find(function (t) {
      return t.id === id;
    }) || null;
  }

  // opts: Shell.open's, and server, the key, for a shell this page hasn't listed yet.
  function show(id, opts) {
    const o = opts || {};
    const t = entry(id);
    return CC.Shell.open({ kind: "terminal", params: { id: id, server: t != null ? t.server : o.server } }, { beside: o.beside === true });
  }

  // A chat's terminal, in the page or Muxy's, beside what's on screen.
  function focus(paneId, server) {
    return owns(paneId) ? show(paneId, { beside: true, server: server != null ? server.key : null }) : CC.host.terminal.focus(paneId);
  }

  // A shell, not shown yet. where: {cwd, projectId, command}. Null when this server's terminals stay native ones, or this one wouldn't start: the caller opens one of those.
  async function create(s, where) {
    try {
      if (await pythonOf(s) == null) {
        return null;
      }
      const project = where.projectId != null ? String(where.projectId) : null;
      const answer = await call(s.key, { op: "open", cwd: where.cwd || null, project: project, command: where.command || null, cols: 100, rows: 30 });
      known = known.concat([{ id: answer.id, cwd: where.cwd || null, project: project, server: s.key }]);
      notify();
      return answer.id;
    } catch (e) {
      console.warn("page terminal not opened", e && e.message);
      return null;
    }
  }

  async function open(s, where, opts) {
    const id = await create(s, where);
    if (id != null) {
      show(id, opts);
    }
    return id;
  }

  function forget(id) {
    known = known.filter(function (t) {
      return t.id !== id;
    });
    titles.delete(id);
    notify();
  }

  // Ends the shell, wherever it's shown. server: for a shell this page hasn't listed yet.
  function close(id, server) {
    const t = entry(id);
    const key = t != null ? t.server : server != null ? server.key : null;
    CC.Shell.panes().forEach(function (p) {
      if (p.kind === "terminal" && p.params.id === id) {
        CC.Shell.close(p.id);
      }
    });
    forget(id);
    return key != null ? call(key, { op: "close", id: id }) : Promise.resolve();
  }

  // As Muxy's panes.list says it, with the folder the shell is in now.
  async function panesOf(s) {
    if (await pythonOf(s).catch(function () { return null; }) == null) {
      return [];
    }
    const all = await read(s);
    return all.filter(function (t) {
      return t.server === s.key;
    }).map(function (t) {
      return { id: t.id, workingDirectory: t.cwd || "" };
    });
  }

  // {server (key), cwd, project} of a shell, the folder as last listed.
  function where(paneId) {
    return entry(String(paneId));
  }

  function serverOf(paneId) {
    const t = entry(String(paneId));
    return t != null ? CC.Servers.get(t.server) : null;
  }

  function titleOf(t) {
    return titles.get(t.id) || String(t.cwd || "").split("/").filter(Boolean).pop() || "Terminal";
  }

  function setTitle(id, title) {
    if (titles.get(id) !== title) {
      titles.set(id, title);
      notify();
    }
  }

  // What CC.ChatTerminals gives for a Muxy pane.
  function rows() {
    return known.map(function (t) {
      return { id: "pane:" + t.id, paneId: t.id, title: titleOf(t), cwd: t.cwd || "", projectId: t.project, server: t.server, status: null, at: null };
    });
  }

  function title(id) {
    return titles.get(id) || "Terminal";
  }

  return {
    start: start, owns: owns, show: show, focus: focus, create: create, open: open, close: close, forget: forget, call: call, panesOf: panesOf, where: where, serverOf: serverOf, rows: rows, setTitle: setTitle, title: title,
    onChange: function (fn) {
      fns.add(fn);
      return function () {
        fns.delete(fn);
      };
    },
  };
})();
