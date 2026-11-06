// What's typed and not sent, in kv `session:<sid>/draft`, so it follows the chat to any pane and over a reload. The page also keeps it per
// runtime: going back to a chat shows it at once, without waiting for the server. Text typed before the server answers wins over its draft.
CC.Composer.use((function () {
  const SAVE_MS = 500;
  const known = new WeakMap();

  return function (composer) {
    const rt = composer.runtime;
    const scope = "session:" + rt.id;
    let timer = null;
    let restoring = false;
    let dirty = false;

    function save() {
      clearTimeout(timer);
      dirty = false;
      const value = composer.value();
      Promise.resolve(value !== "" ? CC.Servers.of(rt).host.kv.set(scope, "draft", value) : CC.Servers.of(rt).host.kv.del(scope, "draft")).catch(function (e) {
        console.warn("draft not saved", e && e.message);
      });
    }

    function restore(text) {
      restoring = true;
      composer.setValue(text);
      restoring = false;
    }

    composer.on("input", function () {
      if (!restoring) {
        known.set(rt, composer.value());
        dirty = true;
        clearTimeout(timer);
        timer = setTimeout(save, SAVE_MS);
      }
      return false;
    });

    composer.onDispose(function () {
      if (dirty) {
        save();
      }
    });

    if (known.has(rt)) {
      restore(known.get(rt));
      return;
    }
    Promise.resolve(CC.Servers.of(rt).host.kv.get(scope, "draft")).then(function (draft) {
      if (!composer.disposed && !known.has(rt) && typeof draft === "string" && draft !== "") {
        known.set(rt, draft);
        restore(draft);
      }
    }).catch(function (e) {
      console.warn("draft not loaded", e && e.message);
    });
  };
})());
