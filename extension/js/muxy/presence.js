// Is the person looking at this page, and at which chat. The checks that depend on it (sounds, Cmd+E) only ask here.
CC.Presence = (function () {
  function inFront() {
    return document.visibilityState !== "hidden" && CC.host.app.focused();
  }

  function chatShown(id) {
    return !CC.Shell.isSidebarOnly() && CC.Shell.panes().some(function (p) {
      return p.kind === "chat" && p.chatId === id;
    });
  }

  return { inFront: inFront, chatShown: chatShown };
})();
