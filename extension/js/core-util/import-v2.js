// Once per server, before the settings load: what 2.x left in Muxy's storage, which this extension still reads under the same id, goes to this server's
// kv. 2.x shared its settings between servers, so each server takes its own copy on its first run. A value already on the server stays; the op sees to that.
// The storage is left as it is, so 2.x still finds its values after a rollback. Left out: queued rows (they would send themselves), review comments (kept per
// tab, here per checkout), chats in terminal mode (a stale pane), the tab index and per tab folds, which have no meaning here.
CC.ImportV2 = (function () {
  const MARK = "v2Imported";
  const PIECE_BYTES = 256 * 1024;
  const SID = /^[A-Za-z0-9_-]{1,80}$/;
  const SIDEBAR_FIELDS = ["lines", "text", "meta", "maxAgeDays", "showTerminals", "sortProjects", "sortChats"];

  function wanted(key) {
    return /^settings:/.test(key) || /^(pins|draft|session):/.test(key) || key === "sidebar:ui" || /^review:(mode|side|sideWidth)$/.test(key);
  }

  function sidebarView(saved) {
    const view = {};
    SIDEBAR_FIELDS.forEach(function (f) {
      if (saved[f] !== undefined) {
        view[f] = saved[f];
      }
    });
    return view;
  }

  function reviewOptions(old) {
    const opts = {};
    if (old["review:mode"] != null) {
      opts.split = old["review:mode"] === "split";
    }
    if (typeof old["review:side"] === "boolean") {
      opts.side = old["review:side"];
    }
    if (typeof old["review:sideWidth"] === "number") {
      opts.width = old["review:sideWidth"];
    }
    return opts;
  }

  // Old values by their old keys → [{scope, key, value}].
  function plan(old) {
    const items = [];
    function add(scope, key, value) {
      items.push({ scope: scope, key: key, value: value });
    }
    [["settings:typography", "typography"], ["settings:notify", "notify"]].forEach(function (s) {
      if (old[s[0]] != null && typeof old[s[0]] === "object") {
        add("settings", s[1], old[s[0]]);
      }
    });
    if (old["settings:sidebar"] != null && typeof old["settings:sidebar"] === "object") {
      add("settings", "sidebar", sidebarView(old["settings:sidebar"]));
    }
    if (old["settings:defaultMode"] === "terminal" || old["settings:defaultMode"] === "chat") {
      add("settings", "defaultMode", old["settings:defaultMode"]);
    }
    if (typeof old["settings:autoReturn"] === "boolean") {
      add("settings", "autoReturn", old["settings:autoReturn"]);
    }
    const review = reviewOptions(old);
    if (Object.keys(review).length > 0) {
      add("ui", "review", review);
    }
    Object.keys(old).forEach(function (k) {
      const value = old[k];
      if (k.indexOf("pins:") === 0 && SID.test(k.slice("pins:".length)) && Array.isArray(value) && value.length > 0) {
        add("session:" + k.slice("pins:".length), "pins", value);
      }
      // A draft was kept per tab, and session:<tab> says which chat that tab held.
      if (k.indexOf("draft:") === 0 && typeof value === "string" && value !== "") {
        const sid = old["session:" + k.slice("draft:".length)];
        if (typeof sid === "string" && SID.test(sid)) {
          add("session:" + sid, "draft", value);
        }
      }
    });
    return items;
  }

  function pieces(items) {
    const out = [];
    let piece = [];
    let bytes = 0;
    items.forEach(function (item) {
      const size = JSON.stringify(item).length;
      if (piece.length > 0 && bytes + size > PIECE_BYTES) {
        out.push(piece);
        piece = [];
        bytes = 0;
      }
      piece.push(item);
      bytes += size;
    });
    if (piece.length > 0) {
      out.push(piece);
    }
    return out;
  }

  // Project order sits inside `ui/sidebar` with values only 3.x has, so it joins them unless the user has already ordered projects here.
  async function projectOrder(old) {
    const order = old["sidebar:ui"] != null ? old["sidebar:ui"].projectOrder : null;
    if (!Array.isArray(order) || order.length === 0) {
      return;
    }
    const now = await CC.Servers.appKv().get("ui", "sidebar");
    if (now != null && Array.isArray(now.projectOrder) && now.projectOrder.length > 0) {
      return;
    }
    await CC.Servers.appKv().set("ui", "sidebar", Object.assign({}, now, { projectOrder: order.map(String) }));
  }

  // Each server has its own chats to bring over.
  async function importTo(server) {
    const keys = ((await CC.host.legacy.keys()) || []).filter(wanted);
    if (keys.length === 0 || CC.probeCore.noChats(await server.host.probe())) {
      return;
    }
    if ((await server.host.kv.get("ui", MARK)) != null) {
      return;
    }
    const values = await Promise.all(keys.map(function (k) {
      return CC.host.legacy.get(k);
    }));
    const old = {};
    keys.forEach(function (k, i) {
      old[k] = values[i];
    });
    const total = { set: 0, kept: 0, skipped: 0 };
    for (const piece of pieces(plan(old))) {
      const reply = await server.host.call("kvImport", { items: piece });
      Object.keys(total).forEach(function (k) {
        total[k] += reply[k] || 0;
      });
    }
    await projectOrder(old);
    await server.host.kv.set("ui", MARK, Object.assign({ at: Date.now() }, total));
  }

  // Never in the way of the app: what failed comes again at the next start, and nothing here overwrites.
  async function run() {
    for (const server of CC.Servers.list()) {
      if (server.experience === "chat" && server.state === "up") {
        try {
          await importTo(server);
        } catch (e) {
          console.warn("2.x values not imported on " + server.name + ":", e && e.message ? e.message : e);
        }
      }
    }
  }

  return { run: run, plan: plan, pieces: pieces, wanted: wanted };
})();
