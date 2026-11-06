// The registry of pane kinds. A kind marked `fallback` (sample content) yields to a real one, whatever the load order.
CC.Panes = (function () {
  const kinds = new Map();

  function register(kind, def) {
    const current = kinds.get(kind);
    if (current != null && current.fallback !== true && def.fallback === true) {
      return;
    }
    kinds.set(kind, def);
  }

  function get(kind) {
    return kinds.get(kind) || null;
  }

  return { register: register, get: get };
})();
