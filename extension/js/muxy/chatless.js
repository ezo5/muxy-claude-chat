// No server where chats can start (probe: no Claude Code or no Python): the page is the list over the whole pane, so in a Muxy split it sits beside
// a native terminal. Settings leaves that state, as any pane does; with the last pane closed there's nothing else to show, so it comes back.
CC.Chatless = (function () {
  async function start() {
    if (CC.Servers.started()) {
      if (CC.Servers.list().some(function (s) { return s.experience === "chat"; })) {
        return;
      }
    } else {
      let found = null;
      try {
        found = await CC.Servers.focused().host.probe();
      } catch (e) {
        console.warn("probe failed", e && e.message);
      }
      if (!CC.probeCore.noChats(found)) {
        return;
      }
    }
    CC.Shell.setSidebarOnly(true);
    // After the change that's under way: opening a pane leaves the state first and adds the pane after.
    CC.bus.on("shell:changed", function () {
      Promise.resolve().then(function () {
        if (!CC.Shell.isSidebarOnly() && CC.Shell.panes().length === 0) {
          CC.Shell.setSidebarOnly(true);
        }
      });
    });
  }

  return { start: start };
})();
