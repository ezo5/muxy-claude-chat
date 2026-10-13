window.CC = window.CC || {};
CC.adapters = CC.adapters || {};

// V1 reader items (already normalized by reader.py parse) → store. The store keeps orphan results, so a tool in a
// chunk loaded later still finds the result that arrived first.
CC.adapters.transcript = (function () {
  function append(store, items) {
    return store.add(items || []);
  }

  function prepend(store, items) {
    return store.prepend(items || []);
  }

  return { append: append, prepend: prepend };
})();
