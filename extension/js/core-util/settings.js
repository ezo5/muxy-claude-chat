// Page-wide settings on kv `settings`. get is synchronous, so boot loads them before anything is mounted.
CC.settings = (function () {
  const values = new Map();

  async function read() {
    const keys = await CC.Servers.appKv().list("settings");
    const got = await Promise.all(keys.map(function (k) {
      return CC.Servers.appKv().get("settings", k);
    }));
    return keys.map(function (k, i) {
      return [k, got[i]];
    });
  }

  async function load() {
    try {
      (await read()).forEach(function (pair) {
        values.set(pair[0], pair[1]);
      });
    } catch (e) {
      console.warn("settings not loaded, using defaults:", e && e.message);
    }
  }

  // Takes what another page of this server changed in kv, which has no change events. Typography calls it on focus.
  async function reload() {
    try {
      (await read()).forEach(function (pair) {
        if (JSON.stringify(values.get(pair[0])) !== JSON.stringify(pair[1])) {
          values.set(pair[0], pair[1]);
          CC.bus.emit("settings:changed", { key: pair[0] });
        }
      });
    } catch (e) {
      console.warn("settings not reloaded:", e && e.message);
    }
  }

  function get(key) {
    return values.has(key) ? values.get(key) : null;
  }

  function set(key, value) {
    values.set(key, value);
    CC.bus.emit("settings:changed", { key: key });
    return CC.Servers.appKv().set("settings", key, value);
  }

  return { load: load, reload: reload, get: get, set: set };
})();
