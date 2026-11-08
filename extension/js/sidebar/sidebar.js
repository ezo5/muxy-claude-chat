// The sidebar of the page: header, tree, one sentence when something is missing. Everything about a chat comes from CC.Chats, so a redraw is always safe.
CC.Sidebar = (function () {
  const el = CC.util.el;
  const SAVE_DELAY_MS = 200;
  const PROBE_EVERY_MS = 5 * 60 * 1000;
  const BRANCHES_EVERY_MS = 60 * 1000;
  const BRANCHES_TIMEOUT_MS = 30 * 1000;
  const HIDE_OPTIONS = [0, 1, 3, 7, 30];
  const SORTS = [["manual", "Manual"], ["name", "Name"], ["activity", "Last activity"], ["status", "Status"]];
  const SOURCES = [["reply", "Last reply"], ["prompt", "Last prompt"], ["both", "Both"]];
  let current = null;

  function labelOf(pairs, value) {
    return pairs.find(function (p) {
      return p[0] === value;
    })[1];
  }

  function hideLabel(days) {
    return days === 0 ? "Never" : days === 1 ? "After 1 day" : "After " + days + " days";
  }

  function fail(prefix, e) {
    CC.ui.toast(prefix + ": " + (e && e.message ? e.message : e), { level: "error" });
  }

  // The sample runs without a server and must not ask for exec.
  function hasServer() {
    return CC.devSample == null;
  }

  function wantsBeside(e) {
    return e != null && (e.metaKey === true || e.ctrlKey === true);
  }

  function mount(root, env) {
    const shell = env.shell;
    const S = { view: CC.SidebarModel.normalizeView(CC.settings.get("sidebar")), collapsed: {}, open: {}, rowOrder: [], projectOrder: [], projects: [], mine: null, active: new Set(), numbers: false, serverDown: false, branches: {}, chatless: false, selectedProject: null };
    const offs = [];
    const answering = new Set();
    let saveTimer = null;
    let unmounted = false;
    let orderRead = false;
    const readingBranches = new Set();

    // --- state ---

    function save() {
      if (saveTimer != null) {
        clearTimeout(saveTimer);
      }
      saveTimer = setTimeout(function () {
        saveTimer = null;
        const value = { collapsed: S.collapsed, open: S.open, rowOrder: S.rowOrder, projectOrder: S.projectOrder };
        Promise.resolve(CC.Servers.appKv().set("ui", "sidebar", value)).catch(function (e) {
          console.warn("sidebar state not saved", e && e.message);
        });
      }, SAVE_DELAY_MS);
    }

    async function load() {
      let saved = null;
      try {
        saved = await CC.Servers.appKv().get("ui", "sidebar");
      } catch (e) {
        console.warn("sidebar state not read", e && e.message);
        return;
      }
      orderRead = true;
      if (unmounted) {
        return;
      }
      if (saved != null) {
        S.collapsed = saved.collapsed || {};
        S.open = saved.open || {};
        S.rowOrder = saved.rowOrder || [];
        S.projectOrder = saved.projectOrder || [];
      }
      render();
    }

    async function loadProjects() {
      try {
        S.projects = (await CC.host.projects.list()) || [];
      } catch (e) {
        console.warn("projects not read", e && e.message);
        S.projects = [];
      }
      if (hasServer() && S.projects.length > 0 && !CC.Servers.started()) {
        S.mine = await CC.SidebarProjects.mineIds(S.projects, S.chatless);
      }
      if (!unmounted) {
        render();
        readBranches(true);
      }
    }

    // The folders to ask about on a server: its projects and its chats'. Two servers can have the same path, so each has its own answers.
    function branchFolders(server) {
      const ids = server.projectIds;
      const folders = S.projects.filter(function (p) {
        return p.path && (ids.length > 0 ? ids.indexOf(String(p.id)) >= 0 : S.mine == null || S.mine.has(String(p.id)));
      }).map(function (p) {
        return p.path;
      });
      CC.Chats.rows().forEach(function (r) {
        if (r.kind === "chat" && r.cwd && r.server === server.key) {
          folders.push(r.cwd);
        }
      });
      return Array.from(new Set(folders));
    }

    function branchesOf(server) {
      if (S.branches[server.key] == null) {
        S.branches[server.key] = {};
      }
      return S.branches[server.key];
    }

    // The overview has no branch, so the reader's op says it, one call per server for all its folders. A folder without git has none. A failed call or a folder it left out keeps
    // what was known, and comes again with the next round.
    async function readBranchesOf(server, all) {
      const known = branchesOf(server);
      const cwds = branchFolders(server).filter(function (cwd) {
        return all === true || !(cwd in known);
      });
      if (cwds.length === 0) {
        return;
      }
      readingBranches.add(server.key);
      let said = {};
      try {
        said = (await server.host.call("branches", { cwds: cwds }, { timeoutMs: BRANCHES_TIMEOUT_MS })).branches || {};
      } catch (e) {
        console.warn("branches not read", e && e.message);
      }
      readingBranches.delete(server.key);
      if (unmounted) {
        return;
      }
      let changed = false;
      cwds.forEach(function (cwd) {
        const branch = cwd in said ? said[cwd] : cwd in known ? known[cwd] : null;
        changed = changed || known[cwd] !== branch;
        known[cwd] = branch;
      });
      if (changed) {
        render();
      }
    }

    // A server without chats runs no Python, and one away can't say. Each on its own, so a slow one doesn't hold the others.
    // all: every folder again; otherwise only the ones not asked yet.
    function readBranches(all) {
      if (!hasServer() || S.chatless) {
        return;
      }
      CC.Servers.list().forEach(function (server) {
        if (server.experience === "chat" && server.state === "up" && !readingBranches.has(server.key)) {
          readBranchesOf(server, all);
        }
      });
    }

    // Only while the page can be seen, with one read on coming back.
    let branchTimer = null;
    function followBranches() {
      clearInterval(branchTimer);
      branchTimer = document.hidden ? null : setInterval(function () {
        readBranches(true);
      }, BRANCHES_EVERY_MS);
    }
    function pageShownOrHidden() {
      followBranches();
      if (!document.hidden) {
        readBranches(true);
      }
    }

    function readActive() {
      // A diff of another chat beside this one doesn't make that chat the open one.
      const panes = shell.panes();
      const chats = panes.filter(function (p) {
        return p.kind === "chat" || p.kind === "terminal";
      });
      S.active = new Set((chats.length > 0 ? chats : panes).map(function (p) {
        return p.kind === "terminal" ? "pane:" + p.params.id : p.chatId;
      }).filter(function (id) {
        return id != null;
      }));
    }

    function modelNow() {
      const rows = CC.Chats.rows();
      const flat = CC.Servers.list()[0];
      return CC.SidebarModel.build({
        rows: rows, projects: S.projects, mineIds: S.mine, view: S.view, collapsed: S.collapsed, open: S.open, rowOrder: S.rowOrder, projectOrder: S.projectOrder, active: S.active, now: Date.now(), branches: flat != null ? branchesOf(flat) : {}, chatless: S.chatless, selectedProject: S.selectedProject,
        servers: hasServer() ? CC.SidebarServers.tree(rows, S.branches) : null,
      });
    }

    // With no pane open the page sits under the first project where Claude runs, unless one was picked, and offers a chat there.
    function offerEmptyPage() {
      if (shell.panes().length > 0) {
        if (S.autoSelected) {
          S.selectedProject = null;
          S.autoSelected = false;
        }
        return;
      }
      const items = modelNow().items;
      const first = items.find(function (it) {
        const server = it.project != null ? CC.Servers.ofProject(it.project.id) : null;
        return server != null && server.experience === "chat";
      });
      if (S.selectedProject == null && first != null) {
        S.selectedProject = first.key;
        S.autoSelected = true;
      }
      const target = items.find(function (it) {
        return it.project != null && it.key === S.selectedProject;
      }) || first;
      shell.setEmptyOffer(target == null ? null : {
        text: "No chat open in " + target.label + ".",
        run: function () { newChat(target.project); },
      });
    }

    function render() {
      if (dnd.active()) {
        return;
      }
      // Not before the saved order is read: this would save over it.
      const locked = orderRead ? CC.SidebarModel.lockOrder(CC.Chats.rows(), S.rowOrder) : S.rowOrder;
      if (locked !== S.rowOrder) {
        S.rowOrder = locked;
        save();
      }
      offerEmptyPage();
      const model = modelNow();
      const numbers = {};
      if (S.numbers) {
        model.order.slice(0, 9).forEach(function (id, i) {
          numbers[id] = i + 1;
        });
      }
      tree.render(model, numbers);
      setTitle();
    }

    // Without chats anywhere, terminals are all this list holds.
    function noChatsAnywhere() {
      return CC.Servers.started() ? !CC.Servers.list().some(function (s) { return s.experience === "chat"; }) : S.chatless;
    }

    function setTitle() {
      const title = noChatsAnywhere() ? "Terminals" : "Chats";
      if (title !== S.title) {
        S.title = title;
        top.set({ title: title, lead: [collapse], actions: topActions });
      }
    }

    // --- actions ---

    function defaultCwd() {
      const pane = shell.focused();
      const row = pane != null && pane.chatId != null ? CC.Chats.get(pane.chatId) : null;
      if (row != null && row.cwd != null) {
        return row.cwd;
      }
      const server = CC.Servers.focused();
      const mine = S.projects.filter(function (p) {
        return server.projectIds.length > 0 ? server.projectIds.indexOf(String(p.id)) >= 0 : S.mine == null || S.mine.has(String(p.id));
      });
      const here = mine.find(function (p) {
        return p.isActive === true;
      }) || mine[0];
      return here != null ? here.path : undefined;
    }

    function newLabel() {
      return CC.Servers.focused().experience === "chat" && !S.chatless ? "New chat" : "New terminal";
    }

    // Without Claude on this server New chat is a plain terminal, as the top bar's is.
    async function newChat(project) {
      const cwd = project != null && project.path ? project.path : defaultCwd();
      // Without a project, defaultCwd() is the focused server's, and a path alone may be on two.
      const server = (project != null ? CC.Servers.ofProject(project.id) : null) || CC.Servers.focused();
      let probe = null;
      if (hasServer()) {
        try {
          probe = await server.host.probe();
        } catch (e) {
          console.warn("probe failed", e && e.message);
        }
      }
      try {
        if (probe != null && probe.experience !== "chat") {
          if (await CC.PageTerminals.open(server, { cwd: cwd, projectId: project != null ? project.id : server.route })) {
            return;
          }
          const pane = await CC.host.terminal.open({ cwd: cwd, projectId: project != null ? project.id : server.route });
          if (pane.paneId != null) {
            await CC.host.terminal.focus(pane.paneId);
          }
          return;
        }
        const id = await CC.Chats.create({ cwd: cwd, server: server.key });
        shell.open({ kind: "chat", chatId: id });
      } catch (e) {
        fail("The chat didn't start", e);
        checkClaude(true);
      }
    }

    // In the tab's own project a terminal can sit in a Muxy split beside this list. Anywhere else, going to it leaves the app, which should be as it was on the way back.
    function besideApp(row) {
      const data = CC.host.app.data();
      return !CC.Servers.started() || (data != null && data.projectId != null && String(row.projectId) === String(data.projectId));
    }

    function pick(row, e) {
      S.selectedProject = null;
      render();
      if (row.kind === "terminal" && CC.PageTerminals.owns(row.paneId)) {
        CC.PageTerminals.show(row.paneId, { beside: wantsBeside(e) });
        return;
      }
      if (row.kind === "terminal") {
        // In a Muxy split the app is then just this list beside the native terminal.
        const was = shell.isSidebarOnly();
        if (besideApp(row)) {
          shell.setSidebarOnly(true);
        }
        Promise.resolve(CC.host.terminal.focus(row.paneId)).catch(function (err) {
          shell.setSidebarOnly(was);
          fail("That terminal can't be shown", err);
        });
        return;
      }
      CC.Chats.markRead(row.id);
      shell.open({ kind: "chat", chatId: row.id }, { beside: wantsBeside(e) });
    }

    async function close(row) {
      shell.panes().filter(function (p) {
        return p.chatId === row.id;
      }).forEach(function (p) {
        shell.close(p.id);
      });
      try {
        await CC.Chats.close(row.id);
      } catch (e) {
        fail("Couldn't close it", e);
      }
    }

    // Asks the server first: what the row says may be older than what the chat is asking now.
    async function allow(row) {
      if (answering.has(row.id)) {
        return;
      }
      answering.add(row.id);
      try {
        const extra = CC.SidebarModel.stillPending(await (CC.Servers.get(row.server) || CC.Servers.focused()).host.call("state", { sessionId: row.id }), row.req);
        if (extra == null) {
          CC.ui.toast("That request isn't open any more, or needs more than a yes. Open the chat to answer.");
          return;
        }
        await CC.Chats.answer(row.id, row.req, "allow", extra);
      } catch (e) {
        fail("Couldn't allow it, open the chat to answer", e);
      } finally {
        answering.delete(row.id);
      }
    }

    // The overview names running subagents but not their transcripts, which the pane needs ({file, title, daemon, cwd}); only the op `agents` knows.
    // A running subagent means a running chat, so opening its runtime resumes nothing. At most one agent pane per chat, as the rail's card does.
    async function openAgent(chatId, agent, e) {
      try {
        const runtime = CC.Chats.open(chatId);
        await runtime.ready;
        const file = runtime.transcriptFile();
        const daemon = runtime.mode() === "chat" ? runtime.id : null;
        const res = file != null ? await CC.Servers.of(runtime).host.call("agents", { file: file, daemon: daemon }) : null;
        const found = (res != null && res.agents != null ? res.agents : []).find(function (a) {
          return a.id === agent.id;
        });
        const transcript = found != null ? found.file || found.inline || null : null;
        if (transcript == null) {
          CC.ui.toast("No transcript for this agent yet");
          return;
        }
        const panes = shell.panes().filter(function (p) {
          return p.kind === "agent" && p.chatId === chatId;
        });
        if (panes.length > 0 && panes[0].params != null && panes[0].params.file === transcript) {
          shell.focus(panes[0].id);
          return;
        }
        if (panes.length > 0) {
          shell.close(panes[0].id);
        }
        shell.open({ kind: "agent", chatId: chatId, params: { file: transcript, title: agent.label, daemon: daemon, cwd: runtime.cwd } }, { beside: wantsBeside(e) });
      } catch (err) {
        fail("The agent's transcript can't be shown", err);
      }
    }

    // Muxy's current project can't follow this click: switching it would leave the app's tab. New Chat asks here instead.
    function selectProject(key) {
      S.selectedProject = key;
      S.autoSelected = false;
      render();
    }

    function selectedProject() {
      const item = modelNow().items.find(function (it) {
        return it.key === S.selectedProject;
      });
      return item != null ? item.project : null;
    }

    function toggleGroup(key) {
      const item = modelNow().items.find(function (it) {
        return it.key === key;
      });
      S.collapsed[key] = item == null || item.collapsed !== true;
      save();
      render();
    }

    function toggleKids(id, open) {
      S.open[id] = open;
      save();
      render();
    }

    async function rename(row) {
      const name = await CC.SidebarProjects.renameDialog(row.title);
      if (name != null) {
        Promise.resolve(CC.Chats.rename(row.id, name)).catch(function (e) {
          fail("Couldn't rename it", e);
        });
      }
    }

    // Adding goes through that server's own CLI, and the form says which.
    function addProject(server) {
      const to = server != null ? server : CC.Servers.focused();
      CC.SidebarProjects.addDialog(to).catch(function (e) {
        fail("Couldn't add the project", e);
      });
    }

    async function removeProject(item) {
      try {
        const choice = await CC.host.ui.confirm("Remove " + item.label + " from Muxy? The folder stays.", ["Remove", "Cancel"]);
        if (choice === "Remove") {
          await CC.host.projects.remove(item.project.id);
        }
      } catch (e) {
        fail("Couldn't remove the project", e);
      }
    }

    // The order is the sidebar's own as well, so it holds where Muxy refuses to reorder.
    function dropProject(ids) {
      const manual = CC.SidebarModel.applyOrder(S.projects, S.projectOrder).map(function (p) {
        return String(p.id);
      });
      S.projectOrder = CC.SidebarDnd.mergeOrder(manual, ids);
      if (CC.host.projects.reorder != null) {
        const homes = new Set(S.projects.filter(CC.SidebarModel.isHome).map(function (p) {
          return String(p.id);
        }));
        Promise.resolve(CC.host.projects.reorder(CC.SidebarDnd.mergeOrder(manual, ids, homes))).catch(function (e) {
          console.warn("Muxy kept its own project order", e && e.message);
        });
      }
    }

    function drop(kind, scope, ids) {
      if (kind === "project") {
        dropProject(ids);
      } else {
        const all = CC.SidebarModel.applyOrder(CC.Chats.rows(), S.rowOrder).map(function (r) {
          return r.id;
        });
        S.rowOrder = CC.SidebarDnd.mergeOrder(all, ids);
      }
      save();
    }

    // --- menus ---

    function rowMenu(row, e) {
      const items = [];
      if (row.kind === "terminal") {
        items.push({ label: "Show terminal", icon: "terminal", run: function () { pick(row); } });
      } else {
        items.push({ label: "Open beside", icon: "split", run: function () { pick(row, { metaKey: true }); } });
      }
      items.push({ label: "Rename…", icon: "pencil", run: function () { rename(row); } });
      items.push({ label: "Mark read", icon: "check", disabled: row.unread !== true, run: function () { CC.Chats.markRead(row.id); } });
      items.push({ separator: true });
      items.push({ label: "Close", icon: "x", run: function () { close(row); } });
      CC.ui.menu(items, { at: { x: e.clientX, y: e.clientY } });
    }

    function projectMenu(item, e) {
      const items = [
        { label: item.adds.replace(/ in .*$/, ""), icon: "plus", run: function () { newChat(item.project); } },
        { label: item.collapsed ? "Expand" : "Collapse", icon: item.collapsed ? "chevron" : "chevronDown", run: function () { toggleGroup(item.key); } },
      ];
      items.push({ label: "Add project…", icon: "file", run: function () { addProject(CC.Servers.ofProject(item.project.id)); } });
      if (!item.project.home) {
        items.push({ separator: true });
        items.push({ label: "Remove project…", icon: "trash", danger: true, run: function () { removeProject(item); } });
      }
      CC.ui.menu(items, { at: { x: e.clientX, y: e.clientY } });
    }

    function serverMenu(item, e) {
      const s = CC.Servers.get(item.server.key);
      const items = [
        { label: item.collapsed ? "Expand" : "Collapse", icon: item.collapsed ? "chevron" : "chevronDown", run: function () { toggleGroup(item.key); } },
        { label: "Add project…", icon: "file", run: function () { addProject(s); } },
      ];
      // A plain drop comes back on its own. One that needs the user, such as a refused login, comes back when one of its projects is opened.
      if (s.state === "down") {
        items.push({ label: "Connect", icon: "enter", run: function () { connect(s); } });
      }
      items.push({ label: "Add a server…", icon: "server", run: CC.SidebarServers.showAddHint });
      CC.ui.menu(items, { at: { x: e.clientX, y: e.clientY } });
    }

    function connect(server) {
      Promise.resolve(CC.host.servers.connect(server.route)).catch(function (e) {
        fail("Couldn't connect", e);
      });
    }

    // The options live in setting `sidebar`; settings:changed redraws, from here and from the settings view alike.
    function setView(patch) {
      Promise.resolve(CC.settings.set("sidebar", Object.assign({}, S.view, patch))).catch(function (e) {
        console.warn("sidebar options not saved", e && e.message);
      });
    }

    // keys: the options this one choice sets; the first says what's checked.
    function options(title, pairs, keys) {
      return function () {
        return {
          title: title,
          items: pairs.map(function (pair) {
            return {
              label: pair[1], check: S.view[keys[0]] === pair[0],
              run: function () {
                const patch = {};
                keys.forEach(function (k) {
                  patch[k] = pair[0];
                });
                setView(patch);
              },
            };
          }),
        };
      };
    }

    function viewItems() {
      const v = S.view;
      const hides = HIDE_OPTIONS.map(function (d) {
        return [d, hideLabel(d)];
      });
      const items = [
        { label: "Group by", value: v.groupBy === "state" ? "State" : "Project", sub: options("Group by", [["state", "State"], ["project", "Project"]], ["groupBy"]) },
        { label: "Sort by", value: labelOf(SORTS, v.sortChats), sub: options("Sort by", SORTS, ["sortChats", "sortProjects"]) },
      ];
      if (!noChatsAnywhere()) {
        items.push({ separator: true });
        items.push({ label: "Show terminals", check: v.showTerminals, run: function () { setView({ showTerminals: !v.showTerminals }); } });
        items.push({ label: "Hide inactive chats", check: v.hideInactive, run: function () { setView({ hideInactive: !v.hideInactive }); } });
        items.push({ label: "Hide stopped", value: hideLabel(v.maxAgeDays), sub: options("Hide stopped chats", hides, ["maxAgeDays"]) });
        items.push({ label: "Text lines", value: v.lines === 0 ? "None" : String(v.lines), sub: options("Text lines under a title", [[0, "None"], [1, "1"], [2, "2"], [3, "3"]], ["lines"]) });
        if (v.lines > 0) {
          items.push({ label: "Text shows", value: labelOf(SOURCES, v.text), sub: options("Text shows", SOURCES, ["text"]) });
        }
      }
      items.push({ separator: true });
      items.push({ label: "Add project…", closes: true, run: function () { addProject(null); } });
      items.push({ label: "Add a server…", closes: true, run: CC.SidebarServers.showAddHint });
      items.push({ label: "Reset to defaults", run: function () { setView(CC.SidebarModel.DEFAULTS); } });
      items.push({ label: "Settings…", closes: true, run: function () { CC.SettingsView.open({ section: "sidebar" }); } });
      return items;
    }

    // --- what's missing ---

    function say(text) {
      foot.textContent = text || "";
      foot.hidden = text == null || text === "";
    }

    function setChatless(on) {
      if (S.chatless !== on) {
        S.chatless = on;
        render();
      }
    }

    // What's missing on any server, by name. A server without Claude is a plain terminal user, so nothing to say, and one that's away has its dot.
    function sayMissing() {
      const missing = CC.Servers.list().map(function (s) {
        const note = CC.probeCore.note({ missing: s.missing });
        return note != null ? s.name + ": " + note : null;
      }).filter(Boolean);
      say(missing.length > 0 ? missing.join(" ") : null);
    }

    async function checkClaude(fresh) {
      if (!hasServer() || unmounted) {
        return;
      }
      if (CC.Servers.started()) {
        if (fresh === true) {
          await CC.Servers.find();
        }
        sayMissing();
        return;
      }
      // Without Python the server can't answer at all, and that is the sentence to say.
      let probe = null;
      try {
        probe = await CC.Servers.focused().host.probe({ fresh: fresh === true });
      } catch (e) {
        console.warn("probe failed", e && e.message);
      }
      if (unmounted) {
        return;
      }
      // Claude arrived: chats and their state live on the server, so the page starts over.
      if (S.chatless && probe != null && !CC.probeCore.noChats(probe)) {
        location.reload();
        return;
      }
      // Claude gone from under a page that had it is news. A page that started without it has nothing to say about it.
      const gone = probe != null && probe.missing === "claude" && !S.chatless ? "Claude Code isn't on this server, so New chat opens a terminal." : null;
      const missing = gone != null ? gone : probe != null ? CC.probeCore.note(probe) : null;
      say(missing != null ? missing : S.serverDown ? "This server isn't answering. Trying again." : null);
    }

    // --- Cmd+Shift numbers ---

    function setNumbers(on) {
      if (S.numbers !== on) {
        S.numbers = on;
        render();
      }
    }

    // --- build ---

    const viewButton = CC.ui.iconButton({
      icon: "gear", label: "View",
      onClick: function () {
        CC.SidebarMenus.panel(viewButton, viewItems);
      },
    });
    viewButton.classList.add("sb-view");
    const collapse = CC.ui.iconButton({ icon: "sidebar", label: "Hide chats", onClick: function () { shell.toggleSidebar(); } });
    collapse.classList.add("sb-collapse");
    const topActions = [viewButton, CC.ui.iconButton({ icon: "plus", label: "Add project", onClick: function () { addProject(null); } })];
    const top = CC.ui.bar({ cls: "sb-top", title: "Chats", lead: [collapse], actions: topActions });
    const treeEl = el("nav", "sb-tree");
    const foot = el("div", "sb-foot");
    foot.setAttribute("role", "status");
    foot.hidden = true;
    root.appendChild(top);
    root.appendChild(treeEl);
    root.appendChild(foot);

    const tree = new CC.SidebarView.Tree(treeEl, {
      toggleGroup: toggleGroup, selectProject: selectProject, serverMenu: serverMenu, newChat: newChat, projectMenu: projectMenu, allow: allow, pick: pick, close: close, toggleKids: toggleKids, rowMenu: rowMenu, openAgent: openAgent,
    });
    const dnd = CC.SidebarDnd.attach(treeEl, { onDrop: drop, onEnd: render });
    const tip = CC.SidebarTip.attach(treeEl, function (id) {
      const row = CC.Chats.get(id);
      if (row == null) {
        return null;
      }
      const project = S.projects.find(function (p) {
        return String(p.id) === String(row.projectId);
      });
      return CC.SidebarTip.data(row, project != null ? project.name : null, Date.now());
    });
    treeEl.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      CC.ui.menu([
        { label: newLabel(), icon: "plus", run: function () { newChat(null); } },
        { label: "Add project…", icon: "file", run: function () { addProject(null); } },
      ], { at: { x: e.clientX, y: e.clientY } });
    });

    readActive();
    render();
    offs.push(CC.Chats.on(function () {
      render();
      readBranches(false);
    }));
    offs.push(CC.Servers.on(function () {
      render();
      readBranches(false);
      sayMissing();
    }));
    offs.push(CC.bus.on("shell:changed", function () {
      readActive();
      render();
    }));
    offs.push(CC.bus.on("settings:changed", function (e) {
      if (e != null && e.key === "sidebar") {
        S.view = CC.SidebarModel.normalizeView(CC.settings.get("sidebar"));
        render();
      }
    }));
    offs.push(CC.bus.on("server:down", function () {
      S.serverDown = true;
      checkClaude(false);
    }));
    offs.push(CC.bus.on("server:up", function () {
      S.serverDown = false;
      checkClaude(true);
    }));
    try {
      offs.push(CC.host.projects.onChange(function () {
        loadProjects();
      }));
    } catch (e) {
      console.warn("no project changes from Muxy", e && e.message);
    }
    offs.push(CC.Keys.onModifiers(function (held) {
      setNumbers(held.mod && held.shift);
    }));
    const probeTimer = setInterval(function () {
      checkClaude(true);
    }, PROBE_EVERY_MS);
    followBranches();
    // visibilitychange bubbles to the window, the one place outside CC.Keys it can be heard from.
    window.addEventListener("visibilitychange", pageShownOrHidden);
    // What this server offers comes first: without chats nothing below may start Python.
    (hasServer() ? CC.Servers.focused().host.probe() : Promise.resolve(null)).catch(function (e) {
      console.warn("probe failed", e && e.message);
      return null;
    }).then(function (found) {
      if (unmounted) {
        return;
      }
      setChatless(CC.probeCore.noChats(found));
      load();
      loadProjects();
      checkClaude(false);
    });

    current = {
      order: function () {
        return modelNow().order;
      },
      selectedProject: selectedProject,
      newChat: newChat,
      rowEl: function (id) {
        return treeEl.querySelector('[data-id="' + CSS.escape(id) + '"]');
      },
    };

    return {
      unmount: function () {
        unmounted = true;
        current = null;
        clearInterval(probeTimer);
        clearInterval(branchTimer);
        window.removeEventListener("visibilitychange", pageShownOrHidden);
        if (saveTimer != null) {
          clearTimeout(saveTimer);
        }
        offs.forEach(function (off) {
          if (typeof off === "function") {
            off();
          }
        });
        dnd.detach();
        tip.hide();
        root.replaceChildren();
      },
    };
  }

  return {
    mount: mount,
    // Row ids as drawn, top to bottom, collapsed groups skipped: what Cmd+Shift+1…9 and next / previous walk.
    order: function () {
      return current != null ? current.order() : [];
    },
    // The project last clicked in the tree, where the New Chat shortcut goes. Null once a chat row was picked.
    selectedProject: function () {
      return current != null ? current.selectedProject() : null;
    },
    // Brings a row into view, when the keyboard went somewhere the list doesn't show.
    reveal: function (id) {
      const row = current != null ? current.rowEl(id) : null;
      if (row != null) {
        row.scrollIntoView({ block: "nearest" });
      }
    },
    newChat: function (project) {
      return current.newChat(project);
    },
  };
})();

CC.Shell.sidebar(CC.Sidebar.mount);
