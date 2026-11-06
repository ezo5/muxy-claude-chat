// The only keyboard listener on `document`. Order: composer bindings when focus is in a composer slot, the focused pane's own
// onKey, pane bindings, global bindings. The first that handles the key wins.
CC.Keys = (function () {
  const binds = { composer: [], pane: [], global: [] };
  const mac = /mac|iphone|ipad/i.test(navigator.platform || "");
  const CODE = /^(Key|Digit)(.)$/;
  let paneOf = function () {
    return null;
  };
  let attached = false;

  // "mod" is cmd on a Mac and ctrl elsewhere.
  function normalize(combo) {
    const parts = combo.toLowerCase().split("+");
    const key = parts.pop();
    const mods = parts.map(function (m) {
      if (m === "mod") {
        return mac ? "cmd" : "ctrl";
      }
      return m === "opt" ? "alt" : m;
    });
    return mods.sort().concat(key).join("+");
  }

  function comboOf(e) {
    const mods = [];
    if (e.altKey) {
      mods.push("alt");
    }
    if (e.metaKey) {
      mods.push("cmd");
    }
    if (e.ctrlKey) {
      mods.push("ctrl");
    }
    if (e.shiftKey) {
      mods.push("shift");
    }
    // Option and shift change e.key on a Mac ("∫", "!"), the physical code stays.
    const code = CODE.exec(e.code || "");
    let key = (e.key || "").toLowerCase();
    if (code != null && (e.altKey || e.shiftKey)) {
      key = code[2].toLowerCase();
    }
    return mods.concat(key).join("+");
  }

  function runList(list, combo, e, pane) {
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const enabled = b.combo === combo && (b.when == null || b.when());
      if (enabled && b.run(e, pane) !== false) {
        return true;
      }
    }
    return false;
  }

  function inComposer(target) {
    return target != null && target.closest != null && target.closest('[data-cc-slot="composer"]') != null;
  }

  function handle(e) {
    const combo = comboOf(e);
    const pane = paneOf();
    let handled = inComposer(e.target) && runList(binds.composer, combo, e, pane);
    if (!handled && pane != null && pane.onKey != null) {
      handled = pane.onKey(e) === true;
    }
    if (!handled) {
      handled = runList(binds.pane, combo, e, pane) || runList(binds.global, combo, e, pane);
    }
    if (handled) {
      e.preventDefault();
    }
  }

  function attach() {
    if (attached) {
      return;
    }
    attached = true;
    document.addEventListener("keydown", function (e) {
      if (!e.defaultPrevented) {
        handle(e);
      }
    });
  }

  // run(event, focusedPaneMount); returning false passes the key on.
  function bind(combo, opts) {
    const entry = { combo: normalize(combo), when: opts.when, run: opts.run };
    const list = binds[opts.scope || "global"];
    list.unshift(entry);
    attach();
    return function () {
      list.splice(list.indexOf(entry), 1);
    };
  }

  // fn(held) on every change of the held modifiers, {mod, shift, alt}. Keys bound with CC.Keys can't tell this: a modifier alone is no combo.
  function onModifiers(fn) {
    let last = "";
    function tell(held) {
      const sig = JSON.stringify(held);
      if (sig !== last) {
        last = sig;
        fn(held);
      }
    }
    function fromEvent(e) {
      tell({ mod: e.metaKey === true || e.ctrlKey === true, shift: e.shiftKey === true, alt: e.altKey === true });
    }
    function released() {
      tell({ mod: false, shift: false, alt: false });
    }
    window.addEventListener("keydown", fromEvent, true);
    window.addEventListener("keyup", fromEvent, true);
    window.addEventListener("blur", released);
    return function () {
      window.removeEventListener("keydown", fromEvent, true);
      window.removeEventListener("keyup", fromEvent, true);
      window.removeEventListener("blur", released);
    };
  }

  return {
    bind: bind,
    onModifiers: onModifiers,
    // Shell only: fn returns the focused pane's mount result.
    setPaneSource: function (fn) {
      paneOf = fn;
      attach();
    },
  };
})();
