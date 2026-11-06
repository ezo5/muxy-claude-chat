CC.bus = (function () {
  const handlers = new Map();

  function on(name, fn) {
    if (!handlers.has(name)) {
      handlers.set(name, new Set());
    }
    handlers.get(name).add(fn);
    return function () {
      handlers.get(name).delete(fn);
    };
  }

  // One failing listener must not stop the others: they belong to unrelated parts of the page.
  function emit(name, payload) {
    const set = handlers.get(name);
    if (set == null) {
      return;
    }
    Array.from(set).forEach(function (fn) {
      try {
        fn(payload);
      } catch (e) {
        console.error("bus " + name, e);
      }
    });
  }

  return { on: on, emit: emit };
})();
