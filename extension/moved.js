// A chat tab left open by 2.x. Muxy restores it with its old data, as tab type `chat`, and a page can't close its own tab: this one says where the chat went.
(function () {
  const m = window.muxy;
  const el = function (id) {
    return document.getElementById(id);
  };

  async function sessionOf(data) {
    if (data.mode === "terminal") {
      return null;
    }
    if (typeof data.sessionId === "string" && data.sessionId !== "") {
      return data.sessionId;
    }
    try {
      const kept = await m.storage.get("session:" + m.tabInstanceID);
      return typeof kept === "string" && kept !== "" ? kept : null;
    } catch (e) {
      console.warn("this tab's chat not read:", e && e.message);
      return null;
    }
  }

  async function activeProjectId() {
    try {
      const project = ((await m.projects.list()) || []).find(function (p) {
        return p.isActive === true;
      });
      return project != null ? project.id : null;
    } catch (e) {
      console.warn("projects not read:", e && e.message);
      return null;
    }
  }

  async function openApp(sid, cwd) {
    const data = { projectId: await activeProjectId() };
    if (sid != null) {
      data.intent = { id: Date.now() + "-" + Math.random().toString(36).slice(2), at: Date.now(), kind: "open", chatId: sid, cwd: cwd };
    }
    await m.tabs.open({ kind: "extensionWebView", extension: { id: "claude-chat", tabType: "app", singleton: true, data: data } });
  }

  async function start() {
    const data = m.data != null && typeof m.data === "object" ? m.data : {};
    const sid = await sessionOf(data);
    const cwd = data.cwd || data.directory || null;
    el("text").textContent = sid != null ? "This chat moved to the Claude Chat tab, with its history. You can close this one." : "Claude Chat is one tab now. You can close this one.";
    const button = el("open");
    button.textContent = sid != null ? "Open it there" : "Open Claude Chat";
    button.hidden = false;
    button.addEventListener("click", function () {
      openApp(sid, cwd).catch(function (e) {
        el("text").textContent = "Couldn't open Claude Chat: " + (e && e.message ? e.message : e);
      });
    });
  }

  start().catch(function (e) {
    el("text").textContent = "Claude Chat is one tab now, reached from the top bar icon. (" + (e && e.message ? e.message : e) + ")";
  });
})();
