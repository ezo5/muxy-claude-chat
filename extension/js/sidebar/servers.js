// The servers of the tree, from CC.Servers: each with its rows and projects, as CC.SidebarModel.build takes them.
CC.SidebarServers = (function () {
  const ADD_HINT = "Servers are added in Muxy: Devices at the bottom of its sidebar, then Add Server…. A new server shows here once it has a project in Muxy.";

  CC.icons.laptop = '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>';
  CC.icons.server = '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>';
  CC.icons.enter = '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>';

  // Local has a dot only when something is wrong with it; a remote says either way.
  function stateOf(s) {
    if (s.state === "down") {
      return { state: "down", title: "Offline: " + s.error };
    }
    return s.local ? { state: null, title: null } : { state: "up", title: "Online" };
  }

  // rows: CC.Chats.rows(). branches: {server key: {cwd: name}}. Null until servers are found: one flat list. A terminal in no known project goes under Local, where its path most likely is.
  function tree(rows, branches) {
    if (!CC.Servers.started()) {
      return null;
    }
    return CC.Servers.list().map(function (s) {
      const state = stateOf(s);
      return {
        key: s.key, kind: s.local ? "local" : "remote", name: s.name, title: s.local ? "This computer" : "Remote server " + s.name, state: state.state, stateTitle: state.title,
        rows: rows.filter(function (r) {
          return r.server === s.key || (s.local && r.server == null);
        }),
        ids: new Set(s.projectIds), chatless: s.experience !== "chat", branches: branches[s.key] || {},
      };
    });
  }

  function showAddHint() {
    Promise.resolve(CC.host.ui.confirm(ADD_HINT, ["OK"])).catch(function (e) {
      console.warn("hint not shown", e && e.message);
    });
  }

  return { tree: tree, showAddHint: showAddHint };
})();
