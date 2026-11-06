// Swaps in sample chats and fills every surface with fallbacks, which yield to real registrations. Needs no server: kv stays in this
// browser, where the server's kv ops may not exist yet, and without any exec there's no consent prompt.
CC.devSample.localKv = function () {
  const PREFIX = "cc-sample:";
  const memory = new Map();

  function read(k) {
    try {
      const v = window.localStorage.getItem(PREFIX + k);
      return v != null ? JSON.parse(v) : (memory.has(k) ? memory.get(k) : null);
    } catch (e) {
      return memory.has(k) ? memory.get(k) : null;
    }
  }

  function write(k, value) {
    memory.set(k, value);
    try {
      window.localStorage.setItem(PREFIX + k, JSON.stringify(value));
    } catch (e) {
      console.warn("sample kv stays in memory:", e && e.message);
    }
  }

  function keys(scope) {
    const found = new Set(memory.keys());
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k.indexOf(PREFIX) === 0) {
          found.add(k.slice(PREFIX.length));
        }
      }
    } catch (e) {
      console.warn("sample kv stays in memory:", e && e.message);
    }
    return Array.from(found).filter(function (k) {
      return k.indexOf(scope + "/") === 0;
    }).map(function (k) {
      return k.slice(scope.length + 1);
    });
  }

  return {
    get: function (scope, key) {
      return Promise.resolve(read(scope + "/" + key));
    },
    set: function (scope, key, value) {
      write(scope + "/" + key, value);
      return Promise.resolve({});
    },
    del: function (scope, key) {
      memory.delete(scope + "/" + key);
      try {
        window.localStorage.removeItem(PREFIX + scope + "/" + key);
      } catch (e) {
        console.warn("sample kv stays in memory:", e && e.message);
      }
      return Promise.resolve({});
    },
    list: function (scope) {
      return Promise.resolve(keys(scope));
    },
  };
};

CC.devSample.install = async function () {
  CC.host.kv = CC.devSample.localKv();
  CC.Chats = CC.devSample.makeChats();
  CC.Shell.sidebar(CC.devSample.sidebar, { fallback: true });
  CC.devSample.registerSlots();
  CC.devSample.registerPanes();
  CC.devSample.registerRail();
  const layout = await CC.host.kv.get("ui", "layout");
  if (layout == null) {
    await CC.host.kv.set("ui", "layout", { panes: [{ kind: "chat", chatId: "grid", params: {} }], focus: 0, sidebar: true, rail: true });
  }
};
