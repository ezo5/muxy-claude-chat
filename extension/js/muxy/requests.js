// Chats other extensions ask for through the server's `request` op. Several pages may watch one server, one per project: the one in front takes a
// request at once, a hidden one a moment later, which leaves time for the tab its sender is opening. It starts or opens that chat in this page.
CC.ChatRequests = (function () {
  const HIDDEN_WAIT_MS = 4000;
  const LOOK_MS = 200;

  // The person is writing in the focused pane: the chat goes beside it, and the field keeps the keyboard.
  function writing() {
    const pane = CC.Shell.focused();
    const composer = pane != null && CC.Composer != null && CC.Composer.ofPane != null ? CC.Composer.ofPane(pane.id) : null;
    return composer != null && composer.value().trim() !== "";
  }

  async function chatFor(server, r) {
    if (r.sessionId != null) {
      const rt = CC.Chats.open(r.sessionId, { cwd: r.cwd, server: server.key });
      if (typeof r.prompt === "string" && r.prompt.trim() !== "") {
        await rt.send({ id: CC.util.uid(), text: r.prompt, images: [], previews: [], createdAt: Date.now() });
      }
      return r.sessionId;
    }
    return CC.Chats.create({ cwd: r.cwd, server: server.key, prompt: r.prompt, model: r.model, effort: r.effort, permissionMode: r.permissionMode, pluginDirs: r.pluginDirs, addDirs: r.addDirs,
      appendSystemPromptFile: r.appendSystemPromptFile });
  }

  async function take(server, r) {
    const until = Date.now() + HIDDEN_WAIT_MS;
    while (!CC.Presence.inFront() && Date.now() < until) {
      await CC.util.sleep(LOOK_MS);
    }
    const claim = await server.host.call("requestDone", { id: r.id });
    if (claim.removed !== true) {
      return;
    }
    const keepField = writing();
    const prior = keepField ? CC.Shell.focused().id : null;
    const id = await chatFor(server, r);
    CC.Shell.open({ kind: "chat", chatId: id }, { beside: keepField });
    if (prior != null) {
      CC.Shell.focus(prior);
    }
  }

  function start() {
    CC.Chats.rows();
    const heard = new Set();
    // A request comes through the watch of the server it was written on.
    function listen() {
      CC.Servers.list().forEach(function (server) {
        if (server.experience !== "chat" || heard.has(server.key)) {
          return;
        }
        heard.add(server.key);
        CC.Hub.of(server).requests.on(function (r) {
          take(server, r).catch(function (e) {
            console.warn("chat request failed", e);
            CC.ui.toast("A chat another extension asked for didn't start: " + (e && e.message ? e.message : e), { level: "error" });
          });
        });
      });
    }
    CC.Servers.on(listen);
    listen();
  }

  return { start: start };
})();
