// The servers of all projects. Muxy names no project's server, so each is asked which projects it holds, over the connection Muxy already has. Nothing here starts Python.
CC.Servers = (function () {
  const CHECK_EVERY_MS = 30 * 1000;
  const MEMORY = "servers";
  const ANSWER_WAIT_MS = 4000;
  const TAB = "tab";

  // Until start(), the one server this page has always had: the project's holding its tab, without a name or projects of its own. Its host is looked up at use.
  const tabServer = {
    key: TAB, name: "", local: null, route: null, projectIds: [], experience: "chat", missing: null, state: "up", error: null,
    get host() {
      return CC.host;
    },
  };

  let list = [tabServer];
  let started = false;
  let projects = [];
  let remembered = [];
  let finding = null;
  let findAgain = false;
  let timer = null;
  let offProjects = null;
  const fns = new Set();

  function report() {
    fns.forEach(function (fn) {
      try {
        fn(list);
      } catch (e) {
        console.error("servers listener failed", e);
      }
    });
  }

  function rememberedOf(known, id) {
    return known.find(function (r) {
      return r.ids.indexOf(id) >= 0;
    });
  }

  // Which projects to ask, in two rounds so that one answer spares asking the rest of its server. A remembered server is asked through one project, and if that fails, not
  // through the others: each could wait for the whole timeout.
  function firstRound(all, known) {
    const asked = new Set();
    const out = [];
    all.forEach(function (p) {
      const id = String(p.id);
      const r = rememberedOf(known, id);
      if (r != null ? !asked.has(r) : p.name === "Home") {
        out.push(p);
      }
      if (r != null) {
        asked.add(r);
      }
    });
    return out;
  }

  function secondRound(all, known, answers) {
    const claimed = new Set();
    answers.forEach(function (a) {
      if (a.found != null) {
        (a.found.ids || []).forEach(function (id) {
          claimed.add(id);
        });
      }
    });
    const failed = new Set();
    answers.forEach(function (a, id) {
      if (a.found == null) {
        failed.add(rememberedOf(known, id));
      }
    });
    return all.filter(function (p) {
      const id = String(p.id);
      return !answers.has(id) && !claimed.has(id) && !failed.has(rememberedOf(known, id));
    });
  }

  // all: projects.list(). answers: project id → {found: probe result} | {error}. known: [{host, ids}], what earlier answers said, so a server that's away stays one server with
  // its name. → [{ids, host, found, error}] in Muxy's order.
  function group(all, answers, known) {
    const listed = all.map(function (p) {
      return String(p.id);
    });
    const out = [];
    function groupOf(id) {
      return out.find(function (g) {
        return g.ids.indexOf(id) >= 0;
      });
    }
    function add(g, id) {
      if (listed.indexOf(id) >= 0 && groupOf(id) == null) {
        g.ids.push(id);
      }
    }
    listed.forEach(function (id) {
      const answer = answers.get(id);
      if (answer == null || answer.found == null) {
        return;
      }
      const ids = answer.found.ids;
      // Without a catalog the host name is all there is, and two servers may share it.
      let g = groupOf(id) || out.find(function (o) {
        return ids != null ? ids.some(function (other) { return o.ids.indexOf(other) >= 0; }) : o.found.ids == null && o.host === answer.found.host;
      });
      if (g == null) {
        g = { ids: [], host: answer.found.host, found: answer.found, error: null };
        out.push(g);
      }
      add(g, id);
      (ids || []).forEach(function (other) {
        add(g, other);
      });
    });
    listed.forEach(function (id) {
      if (groupOf(id) != null) {
        return;
      }
      const answer = answers.get(id);
      const r = rememberedOf(known, id);
      let g = r != null ? out.find(function (o) { return o.host === r.host; }) : null;
      if (g == null) {
        g = { ids: [], host: r != null ? r.host : null, found: null, error: answer != null ? answer.error : "Not reached", experience: r != null ? r.experience : null };
        out.push(g);
      }
      add(g, id);
    });
    return out.sort(function (a, b) {
      return listed.indexOf(a.ids[0]) - listed.indexOf(b.ids[0]);
    });
  }

  // Not the host name, which two servers can share: its Home, which Muxy never removes, else any project it has. The first project of projects.list() is always this computer's Home.
  function describe(g, all) {
    const local = all.length > 0 && g.ids.indexOf(String(all[0].id)) >= 0;
    const home = all.find(function (p) {
      return p.name === "Home" && g.ids.indexOf(String(p.id)) >= 0;
    });
    const route = home != null ? String(home.id) : g.ids[0];
    const first = all.find(function (p) {
      return String(p.id) === route;
    });
    return { key: local ? "local" : route, name: local ? "Local" : g.host || first.path || "Remote server", local: local, route: route, projectIds: g.ids };
  }

  // A server keeps its object, for whoever holds one. One that's away keeps what it last offered.
  function settle(groups, all) {
    list = groups.map(function (g) {
      const d = describe(g, all);
      const old = list.find(function (s) {
        return s.key === d.key;
      });
      const server = old != null ? old : { experience: "terminal", missing: null };
      // What its own calls found out stays until they say otherwise.
      const faulted = server.faulted === true;
      Object.assign(server, d, { state: g.found != null && !faulted ? "up" : "down", error: faulted ? server.error : g.error, host: CC.host.server(d.route) });
      if (g.found != null) {
        server.experience = g.found.experience;
        server.missing = g.found.missing;
      } else if (old == null && g.experience != null) {
        // After a restart, away: a server that had chats keeps its Hub, which says when it's back.
        server.experience = g.experience;
      }
      return server;
    });
  }

  async function remember(groups) {
    const next = groups.filter(function (g) {
      return g.host != null;
    }).map(function (g) {
      const experience = g.found != null ? g.found.experience : g.experience;
      return { host: g.host, ids: g.ids, experience: experience != null ? experience : "terminal" };
    });
    if (JSON.stringify(next) === JSON.stringify(remembered)) {
      return;
    }
    remembered = next;
    await CC.host.app.kv.set("ui", MEMORY, next);
  }

  async function ask(all, known) {
    const answers = new Map();
    // The app waits for this at its start, so a server slow to answer counts as away, until its answer comes and everything is asked again.
    function one(p) {
      let late = false;
      const asked = CC.host.server(p.id).probe({ fresh: true }).then(function (found) {
        if (late) {
          find();
        }
        answers.set(String(p.id), { found: found });
      }, function (e) {
        answers.set(String(p.id), { error: e && e.message ? e.message : String(e) });
      });
      const waited = new Promise(function (resolve) {
        setTimeout(function () {
          if (!answers.has(String(p.id))) {
            late = true;
            answers.set(String(p.id), { error: "Not answering yet" });
          }
          resolve();
        }, ANSWER_WAIT_MS);
      });
      return Promise.race([asked, waited]);
    }
    await Promise.all(firstRound(all, known).map(one));
    await Promise.all(secondRound(all, known, answers).map(one));
    return answers;
  }

  async function findOnce() {
    const all = await CC.host.projects.list();
    const answers = await ask(all, remembered);
    const groups = group(all, answers, remembered);
    projects = all;
    settle(groups, all);
    started = true;
    report();
    await remember(groups).catch(function (e) {
      console.warn("servers not remembered", e && e.message);
    });
  }

  // One at a time; a change during a round means one more after it.
  function find() {
    if (finding != null) {
      findAgain = true;
      return finding;
    }
    finding = findOnce().catch(function (e) {
      console.warn("servers not found", e && e.message);
    }).then(function () {
      finding = null;
      if (findAgain) {
        findAgain = false;
        return find();
      }
      return undefined;
    });
    return finding;
  }

  function sameProjects(a, b) {
    function ids(rows) {
      return rows.map(function (p) {
        return String(p.id);
      }).join(" ");
    }
    return ids(a) === ids(b);
  }

  async function projectsChanged() {
    try {
      // Fires on every switch of project too, which changes nothing here.
      if (!sameProjects(await CC.host.projects.list(), projects)) {
        await find();
      }
    } catch (e) {
      console.warn("projects not read", e && e.message);
    }
  }

  // A server that's away: Muxy reconnects it on its own, and a file check asks without waking anything. One whose Hub found the trouble has that Hub to say when it's over.
  async function check() {
    const away = list.filter(function (s) {
      return s.state === "down" && s.faulted !== true;
    });
    const got = await Promise.all(away.map(function (s) {
      return CC.host.servers.check(s.route);
    }));
    if (got.some(function (r) { return r.up === true; })) {
      await find();
    }
  }

  async function start() {
    if (!CC.host.direct) {
      CC.fatal("This version of Muxy doesn't offer the way Claude Chat reaches your servers. Your chats keep running, and terminals still work.");
      return false;
    }
    try {
      const saved = await CC.host.app.kv.get("ui", MEMORY);
      remembered = Array.isArray(saved) ? saved : [];
    } catch (e) {
      console.warn("remembered servers not read", e && e.message);
    }
    Promise.resolve(CC.host.servers.dropShared()).catch(function (e) {
      console.warn("old server entries not removed", e && e.message);
    });
    offProjects = CC.host.projects.onChange(projectsChanged);
    timer = setInterval(function () {
      check().catch(function (e) {
        console.warn("servers not checked", e && e.message);
      });
    }, CHECK_EVERY_MS);
    await find();
    return true;
  }

  function stop() {
    clearInterval(timer);
    if (offProjects != null) {
      offProjects();
    }
  }

  function get(key) {
    return list.find(function (s) {
      return s.key === key;
    }) || null;
  }

  function ofProject(id) {
    if (!started) {
      return tabServer;
    }
    return list.find(function (s) {
      return s.projectIds.indexOf(String(id)) >= 0;
    }) || null;
  }

  // By the event's project when there is one, else the project with the longest prefix over all servers: two servers can share a path.
  function ofCwd(cwd, projectId) {
    if (!started) {
      return tabServer;
    }
    const id = CC.ChatTerminals.projectOfPath(cwd, projects, projectId != null ? String(projectId) : null);
    return id != null ? ofProject(id) : null;
  }

  // Whoever holds a chat's runtime asks this: a read-only view of a transcript and the like may have none.
  function of(runtime) {
    return runtime != null && runtime.server != null ? runtime.server : focused();
  }

  // The app's own state, one set however many servers. On the tab's server until servers are found.
  function appKv() {
    return started ? CC.host.app.kv : tabServer.host.kv;
  }

  // A server for what belongs to no chat: the one of the chat in front, else one that can run chats.
  function focused() {
    const pane = CC.Shell != null && CC.Shell.focused != null ? CC.Shell.focused() : null;
    const row = pane != null && pane.chatId != null && CC.Chats != null ? CC.Chats.get(pane.chatId) : null;
    const shown = row != null && row.server != null ? get(row.server) : null;
    if (shown != null) {
      return shown;
    }
    function offers(s) {
      return s.experience === "chat";
    }
    return list.find(function (s) { return offers(s) && s.state === "up"; }) || list.find(offers) || list[0] || null;
  }

  // What a server's own calls found out: a failed watch, a failed install, another protocol.
  function markDown(key, error) {
    const server = get(key);
    if (server != null && (server.state !== "down" || server.error !== error)) {
      server.state = "down";
      server.error = error;
      server.faulted = true;
      report();
    }
  }

  // It answers again. What it offers doesn't change here: CC.Servers.find asks.
  function markUp(key) {
    const server = get(key);
    if (server != null && server.state !== "up") {
      server.state = "up";
      server.error = null;
      server.faulted = false;
      report();
    }
  }

  return {
    TAB: TAB,
    of: of,
    appKv: appKv,
    tab: function () {
      return tabServer;
    },
    started: function () {
      return started;
    },
    markUp: markUp,
    start: start,
    stop: stop,
    find: find,
    check: check,
    markDown: markDown,
    list: function () {
      return list;
    },
    on: function (fn) {
      fns.add(fn);
      return function () {
        fns.delete(fn);
      };
    },
    get: get,
    ofProject: ofProject,
    ofCwd: ofCwd,
    focused: focused,
    group: group,
  };
})();
