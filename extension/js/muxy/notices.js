// Small floating notes that never block: the one-time layout tip, and the sentence when this server can't be checked. What a checked server
// lacks stays in the sidebar's foot.
CC.Notices = (function () {
  const TIP = "Tip: for more room, pick the Tab Focused layout in Muxy's settings and collapse its sidebar. Everything here works either way.";
  let box = null;

  function add(text, onDismiss) {
    if (box == null || !box.isConnected) {
      box = CC.util.el("div", "cc-notices");
      document.body.appendChild(box);
    }
    const note = CC.util.el("div", "cc-notice cc-floating");
    note.setAttribute("role", "status");
    note.appendChild(CC.util.el("span", "cc-notice-text", text));
    note.appendChild(CC.ui.iconButton({ icon: "x", label: "Dismiss", onClick: function () {
      note.remove();
      if (onDismiss != null) {
        onDismiss();
      }
    } }));
    box.appendChild(note);
    return note;
  }

  // Without kv it stays away: a tip that can't be dismissed for good would come back every time.
  async function tip() {
    let seen = true;
    try {
      seen = (await CC.Servers.appKv().get("ui", "layoutTip")) != null;
    } catch (e) {
      console.warn("layout tip skipped:", e && e.message);
    }
    if (seen) {
      return;
    }
    add(TIP, function () {
      Promise.resolve(CC.Servers.appKv().set("ui", "layoutTip", true)).catch(function (e) {
        console.warn("layout tip not saved:", e && e.message);
      });
    });
  }

  async function checkServer() {
    try {
      await CC.Servers.focused().host.probe({ fresh: true });
    } catch (e) {
      add("Claude Chat couldn't check this server, so chats may not work: " + (e && e.message ? e.message : e) + ". Running programs can be allowed in Muxy's settings, under Extensions.");
    }
  }

  return { add: add, tip: tip, checkServer: checkServer };
})();
