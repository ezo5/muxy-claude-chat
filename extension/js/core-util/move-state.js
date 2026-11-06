// Once, when one page came to hold every server: what each server's page kept for itself becomes the app's one set, in Muxy's storage. Nothing is deleted from the servers.
CC.MoveState = (function () {
  const MARK = "multiImported";
  const OWN = ["layout", "sidebar", "rail", "review", "agentsDone", "limitBanner", "layoutTip"];

  async function firstValue(servers, key) {
    for (const server of servers) {
      const value = await server.host.kv.get("ui", key);
      if (value != null) {
        return { value: value, server: server };
      }
    }
    return null;
  }

  async function copySettings(servers, app) {
    for (const server of servers) {
      const keys = await server.host.kv.list("settings");
      if (keys.length > 0) {
        for (const key of keys) {
          await app.set("settings", key, await server.host.kv.get("settings", key));
        }
        return;
      }
    }
  }

  // Panes say their server from now on, and the chats they show are on the one the layout came from.
  function withServer(key, found) {
    if (key !== "layout" || !Array.isArray(found.value.panes)) {
      return found.value;
    }
    return Object.assign({}, found.value, {
      panes: found.value.panes.map(function (p) {
        return Object.assign({}, p, { server: found.server.key });
      }),
    });
  }

  async function mergeChats(servers, app) {
    const merged = { unread: [], titles: {}, parents: {}, terminal: {} };
    for (const server of servers) {
      const ui = await server.host.kv.get("ui", "chats");
      if (ui != null) {
        merged.unread = merged.unread.concat(ui.unread || []);
        Object.assign(merged.titles, ui.titles);
        Object.assign(merged.parents, ui.parents);
        Object.keys(ui.terminal || {}).forEach(function (id) {
          merged.terminal[id] = Object.assign({}, ui.terminal[id], { server: server.key });
        });
      }
    }
    await app.set("ui", "chats", merged);
  }

  // Without a server to read from there's nothing to do yet, and the next start tries again. Never in the way of the app.
  async function run() {
    const app = CC.Servers.appKv();
    try {
      if ((await app.get("ui", MARK)) != null) {
        return;
      }
      const servers = CC.Servers.list().filter(function (s) {
        return s.experience === "chat" && s.state === "up";
      });
      if (servers.length === 0) {
        return;
      }
      await copySettings(servers, app);
      for (const key of OWN) {
        const found = await firstValue(servers, key);
        if (found != null) {
          await app.set("ui", key, withServer(key, found));
        }
      }
      await mergeChats(servers, app);
      await app.set("ui", MARK, { at: Date.now() });
    } catch (e) {
      console.warn("state of the servers not moved:", e && e.message ? e.message : e);
    }
  }

  return { run: run };
})();
