// The only code that talks to Muxy. dev/mock-host.js sets CC.host first and takes its place in the harness.
(function () {
  if (CC.host != null || window.muxy == null) {
    return;
  }
  const m = window.muxy;
  const NEW_PANE_TRIES = 20;
  const NEW_PANE_WAIT_MS = 100;
  const JOURNAL = "cc-kv-pending:";

  // `project` reaches Muxy only this way: the public exec and execAsync drop it (bridge.js, execPayload). It's the message they send themselves, so consent and limits
  // are the same. Undocumented: a Muxy update can close it, and then CC.host.direct says so.
  const handler = window.webkit != null && window.webkit.messageHandlers != null ? window.webkit.messageHandlers.muxy : null;
  let posted = 0;

  async function post(verb, args) {
    posted += 1;
    const reply = await handler.postMessage({ verb: verb, args: args, requestID: "cc-" + posted });
    if (reply != null && reply.ok) {
      return reply.value;
    }
    throw new Error(reply != null && reply.error ? reply.error : verb + " got no reply");
  }

  // What the public exec takes, in the shape Muxy reads.
  function execArgs(project, cmd, opts) {
    const o = opts || {};
    const args = Array.isArray(cmd) ? { argv: cmd.map(String) } : { shell: String(cmd.shell) };
    args.project = project;
    if (o.stdin != null) {
      args.stdin = String(o.stdin);
    }
    if (o.timeoutMs != null) {
      args.timeoutMs = Number(o.timeoutMs);
    }
    return args;
  }

  // exec.start answers through __muxyResolveExec, whose list of jobs is private to bridge.js: ours are told apart by their ids.
  const started = new Map();
  let hearing = false;
  function hearStarted() {
    if (hearing) {
      return;
    }
    hearing = true;
    const bridge = window.__muxyResolveExec;
    window.__muxyResolveExec = function (id, reply) {
      const job = started.get(String(id));
      if (job == null) {
        return bridge != null ? bridge(id, reply) : undefined;
      }
      started.delete(String(id));
      if (reply.ok) {
        job.resolve(reply.value);
      } else {
        job.reject(startFailure(reply.error, reply.cancelled === true));
      }
      return undefined;
    };
  }

  function startFailure(message, cancelled) {
    const e = new Error(message || "exec failed");
    e.cancelled = cancelled;
    return e;
  }

  function directRoute(project) {
    return {
      exec: function (cmd, opts) {
        return post("exec", execArgs(project, cmd, opts));
      },
      start: function (cmd, opts) {
        hearStarted();
        posted += 1;
        const id = "cc-job-" + posted;
        const result = new Promise(function (resolve, reject) {
          started.set(id, { resolve: resolve, reject: reject });
          post("exec.start", Object.assign(execArgs(project, cmd, opts), { id: id })).catch(function (e) {
            started.delete(id);
            reject(startFailure(e.message, e.message === "cancelled"));
          });
        });
        return {
          result: result,
          cancel: function () {
            return started.has(id) ? post("exec.cancel", { id: id }) : Promise.resolve();
          },
        };
      },
    };
  }

  // The server of the project holding this tab.
  const tabRoute = {
    exec: function (cmd, opts) {
      return m.exec(cmd, opts);
    },
    start: typeof m.execAsync === "function" ? function (cmd, opts) {
      return m.execAsync(cmd, opts);
    } : null,
  };

  // Exit 1 + {"error"} is the server's way to fail, the rest are Muxy's limits.
  function parseReply(op, res) {
    if (res.timedOut) {
      throw new Error(op + " timed out on the server");
    }
    if (res.truncated) {
      throw new Error(op + " returned more than Muxy's 4 MiB limit");
    }
    let body = null;
    try {
      body = JSON.parse(res.stdout);
    } catch (e) {
      const detail = (res.stderr || res.stdout || "no output").trim().split("\n").pop();
      throw new Error(op + " failed: " + detail);
    }
    if (res.exitCode !== 0 || body == null) {
      const failure = new Error(op + " failed: " + (body != null && body.error ? body.error : "exit " + res.exitCode));
      failure.code = body != null ? body.code : undefined;
      throw failure;
    }
    return body;
  }

  // Muxy refuses what's over 32 running per extension, over all servers, and 32 per server, over all extensions, so a burst waits here instead. A server's
  // `watch` never waits: it's what says the server is up. RUNNING_IN_ALL leaves some room for those, as they don't ask.
  const RUNNING_PER_SERVER = 6;
  const RUNNING_IN_ALL = 28;
  const REFUSED_RETRY_MS = [100, 250, 500, 1000];
  // The first is Muxy's, the second a server's, as Muxy words it with the code in front: "BadRequest: too many commands or duplicate job ID".
  const REFUSED = /too many concurrent commands|too many commands or duplicate job ID/;
  const waiting = [];
  let runningInAll = 0;

  // Refused for being busy says nothing about the server, so it's tried again for as long as the call has. busy: what the caller sees when that wasn't enough.
  async function untilTaken(deadline, run) {
    for (let i = 0; ; i++) {
      try {
        // In steps, so a call that waited for nothing gets exactly the timeout it asked for.
        return await run(Math.ceil(Math.max(deadline - Date.now(), 1) / 100) * 100);
      } catch (e) {
        const pause = REFUSED_RETRY_MS[Math.min(i, REFUSED_RETRY_MS.length - 1)];
        if (!REFUSED.test(e && e.message)) {
          throw e;
        }
        if (Date.now() + pause >= deadline) {
          e.busy = true;
          throw e;
        }
        await new Promise(function (resolve) {
          setTimeout(resolve, pause);
        });
      }
    }
  }

  function newTurn(lane, timeoutMs, run) {
    const turn = { lane: lane, deadline: Date.now() + timeoutMs, run: run, timer: null, resolve: null, reject: null, result: null };
    turn.result = new Promise(function (resolve, reject) {
      turn.resolve = resolve;
      turn.reject = reject;
    });
    return turn;
  }

  function begin(turn) {
    runningInAll += 1;
    turn.lane.running += 1;
    untilTaken(turn.deadline, turn.run).then(turn.resolve, turn.reject).then(function () {
      runningInAll -= 1;
      turn.lane.running -= 1;
      pump();
    });
  }

  // In the order asked, skipping a server that's full, so one that hangs holds only its own calls.
  function pump() {
    for (let i = 0; i < waiting.length && runningInAll < RUNNING_IN_ALL;) {
      const turn = waiting[i];
      if (turn.lane.running >= RUNNING_PER_SERVER) {
        i += 1;
      } else {
        waiting.splice(i, 1);
        clearTimeout(turn.timer);
        begin(turn);
      }
    }
  }

  function leaveQueue(turn, failure) {
    const at = waiting.indexOf(turn);
    if (at >= 0) {
      waiting.splice(at, 1);
      clearTimeout(turn.timer);
      turn.reject(failure);
    }
  }

  // run(timeoutMs): one exec, with what's left of timeoutMs, which counts from here, also while waiting: a caller hears within the time it asked for.
  function inTurn(lane, op, timeoutMs, run) {
    const turn = newTurn(lane, timeoutMs, run);
    turn.timer = setTimeout(function () {
      leaveQueue(turn, new Error(op + " timed out waiting for its turn"));
    }, timeoutMs);
    waiting.push(turn);
    pump();
    return turn;
  }

  // A watch: counted, as Muxy counts it, but on no server's list.
  const noLane = { running: 0 };
  function withoutWaiting(timeoutMs, run) {
    const turn = newTurn(noLane, timeoutMs, run);
    begin(turn);
    return turn;
  }

  // One server's calls and kv. tag: what its journal entries are kept under, null for the tab's own.
  function makeServer(route, tag) {
    let probing = null;
    const lane = { running: 0 };

    // Cached per server; {fresh: true} on app open and after a failed start.
    function probe(opts) {
      if (probing == null || (opts != null && opts.fresh === true)) {
        probing = inTurn(lane, "probe", 20000, function (timeoutMs) {
          return Promise.resolve(route.exec({ shell: CC.probeCore.SHELL, timeoutMs: timeoutMs }));
        }).result.then(function (res) {
          return CC.probeCore.parse(res.stdout);
        });
        probing.catch(function () {
          probing = null;
        });
      }
      return probing;
    }

    // python3 comes from the probe and is never started blindly.
    async function pythonPath() {
      const found = await probe();
      if (CC.probeCore.noChats(found)) {
        const refused = new Error(CC.probeCore.message(found) || "Claude Code isn't on this server");
        refused.code = "no-chats";
        throw refused;
      }
      return found.python.path;
    }

    function timeoutOf(opts) {
      return opts != null && opts.timeoutMs != null ? opts.timeoutMs : 40000;
    }

    function execOptions(op, payload, timeoutMs) {
      const stdin = JSON.stringify(Object.assign({ op: op, serverVersion: CC.SERVER_PACKAGE.version }, payload || {}));
      return { stdin: stdin, timeoutMs: timeoutMs };
    }

    async function plainCall(op, payload, opts) {
      const python = await pythonPath();
      return inTurn(lane, op, timeoutOf(opts), async function (timeoutMs) {
        return parseReply(op, await route.exec([python, "-c", CC.BOOTSTRAP_SRC], execOptions(op, payload, timeoutMs)));
      }).result;
    }

    // First use of this version on this server: install the bundle's package, then the request again.
    async function withServer(attempt) {
      try {
        return await attempt();
      } catch (e) {
        if (e.code !== "server-missing") {
          throw e;
        }
      }
      await CC.serverInstall.run(function (piece) {
        return plainCall("serverInstall", piece, { timeoutMs: 60000 });
      }, tag != null ? tag : "tab");
      return attempt();
    }

    function call(op, payload, opts) {
      return withServer(function () {
        return plainCall(op, payload, opts);
      });
    }

    function job(op, payload, opts) {
      let cancelled = false;
      let running = null;
      let turn = null;
      function cancelledError() {
        const e = new Error("cancelled");
        e.cancelled = true;
        return e;
      }
      async function attempt() {
        const python = await pythonPath();
        if (cancelled) {
          throw cancelledError();
        }
        // Checked each time, as a refused one may be waiting to try again.
        async function run(timeoutMs) {
          if (cancelled) {
            throw cancelledError();
          }
          if (route.start == null) {
            return parseReply(op, await route.exec([python, "-c", CC.BOOTSTRAP_SRC], execOptions(op, payload, timeoutMs)));
          }
          running = route.start([python, "-c", CC.BOOTSTRAP_SRC], execOptions(op, payload, timeoutMs));
          return parseReply(op, await running.result);
        }
        turn = op === "watch" ? withoutWaiting(timeoutOf(opts), run) : inTurn(lane, op, timeoutOf(opts), run);
        return turn.result;
      }
      return {
        result: withServer(attempt),
        cancel: function () {
          cancelled = true;
          if (turn != null) {
            leaveQueue(turn, cancelledError());
          }
          if (running != null) {
            Promise.resolve(running.cancel()).catch(function () {});
          }
        },
      };
    }

    // Each call is its own process, so two quick writes of a key could land in either order: one at a time per key, and a read after them.
    const kvLast = new Map();
    function inOrder(scope, key, run) {
      const id = scope + "/" + key;
      const next = (kvLast.get(id) || Promise.resolve()).catch(function () {}).then(run);
      kvLast.set(id, next);
      const forget = function () {
        if (kvLast.get(id) === next) {
          kvLast.delete(id);
        }
      };
      next.then(forget, forget);
      return next;
    }

    // A write not started yet takes the newer value instead of queueing behind it, so typing never builds a line of processes.
    const kvWaiting = new Map();
    function latestWrite(scope, key, run) {
      const id = scope + "/" + key;
      const waiting = kvWaiting.get(id);
      if (waiting != null) {
        waiting.run = run;
        return waiting.done;
      }
      const entry = { run: run, done: null };
      entry.done = inOrder(scope, key, function () {
        kvWaiting.delete(id);
        return entry.run();
      });
      kvWaiting.set(id, entry);
      return entry.done;
    }

    // Each write also stays in the page's own storage until the server has it: a reload comes back and finishes it. Where the webview has no
    // such storage, a write in flight at a reload may be lost, as without this.
      const kvLatest = new Map();
    function journal(scope, key, entry) {
      try {
        const name = JOURNAL + JSON.stringify(tag != null ? [scope, key, tag] : [scope, key]);
        if (entry == null) {
          window.localStorage.removeItem(name);
        } else {
          window.localStorage.setItem(name, JSON.stringify(entry));
        }
      } catch (e) {
        console.warn("kv journal not written", e && e.message);
      }
    }

    function kvWrite(scope, key, entry) {
      const id = scope + "/" + key;
      journal(scope, key, entry);
      kvLatest.set(id, entry);
      return latestWrite(scope, key, function () {
        return entry.del === true ? call("kvDel", { scope: scope, key: key }) : call("kvSet", { scope: scope, key: key, value: entry.value });
      }).then(function (reply) {
        if (kvLatest.get(id) === entry) {
          kvLatest.delete(id);
          journal(scope, key, null);
        }
        return reply;
      });
    }

    // A server without chats runs no Python, so its layout and settings stay in Muxy's own storage, which all servers share: per host name. Decided
    // once for the page's life, so a later probe can't move its state away. Null: on the server, through kv ops.
    let kvPlace = null;
    function kvInMuxy() {
      if (kvPlace == null) {
        kvPlace = probe().then(function (found) {
          return CC.probeCore.noChats(found) ? "kv:" + (found.host || "") + ":" : null;
        }, function () {
          return null;
        });
      }
      return kvPlace;
    }

    const kv = {
      get: async function (scope, key) {
        const place = await kvInMuxy();
        if (place != null) {
          const held = await m.storage.get(place + scope + "/" + key);
          return held != null ? held : null;
        }
        return inOrder(scope, key, function () {
          return call("kvGet", { scope: scope, key: key });
        }).then(function (r) {
          return r.value != null ? r.value : null;
        });
      },
      set: async function (scope, key, value) {
        const place = await kvInMuxy();
        return place != null ? m.storage.set(place + scope + "/" + key, value) : kvWrite(scope, key, { value: value });
      },
      del: async function (scope, key) {
        const place = await kvInMuxy();
        return place != null ? m.storage.delete(place + scope + "/" + key) : kvWrite(scope, key, { del: true });
      },
      list: async function (scope) {
        const place = await kvInMuxy();
        if (place != null) {
          const prefix = place + scope + "/";
          return (await m.storage.keys()).filter(function (k) {
            return k.indexOf(prefix) === 0;
          }).map(function (k) {
            return k.slice(prefix.length);
          });
        }
        return call("kvList", { scope: scope }).then(function (r) {
          return r.keys;
        });
      },
    };

    return { probe: probe, call: call, job: job, kv: kv, write: kvWrite };
  }

  const tab = makeServer(tabRoute, null);
  const probe = tab.probe;
  const call = tab.call;

  const servers = new Map();
  function serverOf(projectId) {
    const id = String(projectId);
    if (!servers.has(id)) {
      servers.set(id, makeServer(directRoute(id), id));
    }
    return servers.get(id);
  }

  function events(names, fn) {
    const offs = names.map(function (name) {
      return m.events.subscribe(name, fn);
    });
    return function () {
      offs.forEach(function (off) {
        off();
      });
    };
  }

  // tabs.open returns only a tab id, so the terminal's pane is the one that wasn't listed before.
  async function newPane(before) {
    const known = new Set(before.map(function (p) {
      return String(p.id);
    }));
    for (let i = 0; i < NEW_PANE_TRIES; i++) {
      const added = (await m.panes.list()).find(function (p) {
        return !known.has(String(p.id));
      });
      if (added != null) {
        return String(added.id);
      }
      await CC.util.sleep(NEW_PANE_WAIT_MS);
    }
    return null;
  }

  function quoted(path) {
    return "'" + String(path).replace(/'/g, "'\\''") + "'";
  }

  // `directory` works only inside the current project and on local ones, so the command changes folder itself.
  async function openTerminal(opts) {
    // tabs.open uses the current project, so a terminal on another server means going to it.
    if (opts.projectId != null) {
      await m.projects.switchTo(opts.projectId);
    }
    const before = await m.panes.list();
    const parts = [];
    if (opts.cwd != null) {
      parts.push("cd " + quoted(opts.cwd));
    }
    if (opts.command != null) {
      parts.push(opts.command);
    }
    const request = { kind: "terminal" };
    if (parts.length > 0) {
      request.command = parts.join(" && ");
    }
    const tabId = await m.tabs.open(request);
    const paneId = await newPane(before);
    return { paneId: paneId, tabId: tabId != null ? String(tabId) : null };
  }

  // The server's own muxy CLI, through the one bootstrap so without a prompt of its own, as projects.create only adds folders on the machine
  // running Muxy. Ids of this server's projects, as projects.list() doesn't say whose they are. Null when the server has no CLI to ask.
  async function projectsOfServer() {
    const found = await probe().catch(function () {
      return null;
    });
    if (CC.probeCore.noChats(found)) {
      return found.ids;
    }
    try {
      const res = await call("muxyProjects", {}, { timeoutMs: 12000 });
      return Array.isArray(res.ids) ? res.ids : null;
    } catch (e) {
      console.warn("this server's projects not read", e && e.message);
      return null;
    }
  }

  // route: a project of the server it goes on; null for the tab's. Through that server's CLI, as projects.create only adds folders on this computer.
  async function addProject(path, opts, route) {
    const o = opts || {};
    const server = route != null ? serverOf(route) : tab;
    const found = await server.probe().catch(function () {
      return null;
    });
    if (CC.probeCore.noChats(found)) {
      return m.projects.create(path, o);
    }
    const res = await server.call("muxyProjectAdd", { path: path, name: o.name, createIfMissing: o.createIfMissing === true }, { timeoutMs: 20000 });
    return res.available === false ? m.projects.create(path, o) : null;
  }

  function finishJournal() {
    let names = [];
    try {
      names = Object.keys(window.localStorage).filter(function (k) {
        return k.indexOf(JOURNAL) === 0;
      });
    } catch (e) {
      return;
    }
    names.forEach(function (name) {
      try {
        const id = JSON.parse(name.slice(JOURNAL.length));
        const owner = id[2] != null ? serverOf(id[2]) : tab;
        owner.write(id[0], id[1], JSON.parse(window.localStorage.getItem(name))).catch(function (e) {
          console.warn("kv write not finished", e && e.message);
        });
      } catch (e) {
        window.localStorage.removeItem(name);
      }
    });
  }

  // One set for the app, wherever its chats run: Muxy's own storage, on this computer.
  const APP_KV = "app:";
  const appKv = {
    get: async function (scope, key) {
      const held = await m.storage.get(APP_KV + scope + "/" + key);
      return held != null ? held : null;
    },
    set: function (scope, key, value) {
      return m.storage.set(APP_KV + scope + "/" + key, value);
    },
    del: function (scope, key) {
      return m.storage.delete(APP_KV + scope + "/" + key);
    },
    list: async function (scope) {
      const prefix = APP_KV + scope + "/";
      return (await m.storage.keys()).filter(function (k) {
        return k.indexOf(prefix) === 0;
      }).map(function (k) {
        return k.slice(prefix.length);
      });
    },
  };

  const SERVER_KEY = "server:";
  const SERVER_CHECK_MS = 8000;

  // A file check on another project's server, the one call that takes a project: over the connection Muxy already holds, starting nothing there. A
  // disconnected server is refused at once and isn't reconnected. up null: nothing known, as without files:read.
  function checkServer(projectId) {
    const stat = Promise.resolve().then(function () {
      return m.files.stat(".", { project: String(projectId) });
    });
    const late = new Promise(function (resolve, reject) {
      setTimeout(function () {
        reject(new Error("the server didn't answer"));
      }, SERVER_CHECK_MS);
    });
    return Promise.race([stat, late]).then(function () {
      return { up: true };
    }, function (e) {
      const error = e && e.message ? e.message : String(e);
      return { up: /permission/i.test(error) ? null : false, error: error };
    });
  }

  CC.host = {
    probe: probe,
    call: call,
    job: tab.job,
    // `project` is what makes this any server. Only with `direct`.
    server: serverOf,
    direct: handler != null,
    kv: tab.kv,
    theme: {
      scheme: function () {
        return m.theme != null && m.theme.colorScheme === "light" ? "light" : "dark";
      },
      onChange: function (fn) {
        return typeof m.onThemeChange === "function" ? m.onThemeChange(fn) : function () {};
      },
    },
    terminal: {
      open: openTerminal,
      // tabs.switchTo takes a pane id and crosses projects.
      focus: function (paneId) {
        return m.tabs.switchTo(paneId);
      },
      close: function (paneId) {
        return m.panes.close(paneId);
      },
      list: function () {
        return m.panes.list();
      },
      readScreen: function (paneId, lines) {
        return m.panes.readScreen(paneId, lines);
      },
      onChange: function (fn) {
        return events(["pane.created", "pane.closed", "pane.focused", "tab.closed"], fn);
      },
      agents: function () {
        return m.agents.list();
      },
      onAgentStatus: function (fn) {
        return events(["agent.status"], fn);
      },
    },
    app: {
      kv: appKv,
      focusSelf: function () {
        return m.tabs.switchTo(m.tabInstanceID);
      },
      setTitle: function (text) {
        return m.tabs.setTitle(text);
      },
      // The one tab, in this computer's Home, which Muxy never removes and whose server is always there.
      openHere: async function () {
        const home = (await m.projects.list())[0];
        await m.projects.switchTo(home.id);
        return m.tabs.open({ kind: "extensionWebView", extension: { id: m.extensionID, tabType: "app", singleton: true, data: { projectId: home.id } } });
      },
      data: function () {
        return m.data;
      },
      onCommand: function (id, fn) {
        return events(["command." + id], fn);
      },
      // A singleton tab's data is replaced when it's opened again.
      onData: function (fn) {
        return typeof m.onDataChange === "function" ? m.onDataChange(fn) : function () {};
      },
      focused: function () {
        return typeof m.focused === "boolean" ? m.focused : document.hasFocus();
      },
    },
    projects: {
      list: function () {
        return m.projects.list();
      },
      onChange: function (fn) {
        return events(["projects.changed", "project.switched"], fn);
      },
      add: addProject,
      ofServer: projectsOfServer,
      reorder: function (ids) {
        return m.projects.reorder(ids);
      },
      remove: function (id) {
        return m.projects.delete(id);
      },
    },
    // What 2.x left in the storage, see CC.ImportV2.
    legacy: {
      keys: function () {
        return m.storage.keys();
      },
      get: function (key) {
        return m.storage.get(key);
      },
    },
    servers: {
      check: checkServer,
      // Opening one of its projects connects a server that doesn't by itself, such as after a refused login. Then back here.
      connect: async function (projectId) {
        await m.projects.switchTo(projectId);
        return m.tabs.switchTo(m.tabInstanceID);
      },
      // What pages told each other before one page held every server: gone once, no longer read.
      dropShared: async function () {
        const keys = (await m.storage.keys()).filter(function (k) {
          return k.indexOf(SERVER_KEY) === 0;
        });
        await Promise.all(keys.map(function (k) {
          return m.storage.delete(k);
        }));
      },
    },
    ui: {
      confirm: function (text, buttons) {
        return m.dialog.confirm({ message: text, buttons: buttons });
      },
      notify: function (opts) {
        return m.notifications.notify(opts);
      },
      toast: function (opts) {
        return m.toast({ title: "Claude Chat", body: opts.text });
      },
      openBrowser: function (url) {
        return m.tabs.open({ kind: "browser", url: url });
      },
    },
  };
  finishJournal();
})();
