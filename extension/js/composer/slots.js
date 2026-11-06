// Puts each pane's composer into the chat slots. Ctrl+C is the one key that also works with focus elsewhere in the pane.
(function () {
  function part(attach) {
    return function (host, ctx) {
      const composer = CC.Composer.forPane(ctx);
      if (composer == null) {
        return null;
      }
      composer.retain();
      attach(host, composer);
      return {
        unmount: function () {
          composer.release();
        },
      };
    };
  }

  CC.ChatPane.slot("flowEnd", part(function (host, c) {
    host.appendChild(c.flowEnd);
  }), { order: 10 });

  CC.ChatPane.slot("aboveComposer", part(function (host, c) {
    host.appendChild(c.above);
  }));

  CC.ChatPane.slot("composer", function (host, ctx) {
    if (ctx.runtime == null) {
      host.appendChild(CC.util.el("div", "cmp-unavailable", "This chat couldn't load, so there's nothing to write to."));
      return null;
    }
    return part(function (el, c) {
      el.appendChild(c.root);
      c.autosize();
    })(host, ctx);
  });

  CC.ChatPane.slot("belowComposer", part(function (host, c) {
    host.appendChild(c.below);
  }));

  // In the field: Enter sends or queues, mod+Enter sends now, Esc interrupts. Plugins with a popup open have taken the key before this.
  function fieldKey(combo, run) {
    CC.Keys.bind(combo, {
      scope: "composer",
      run: function (e) {
        const c = e.isComposing ? null : CC.Composer.ofField(e.target);
        return c != null ? run(c) : false;
      },
    });
  }

  fieldKey("enter", function (c) {
    c.submit(false);
  });
  ["cmd+enter", "ctrl+enter"].forEach(function (combo) {
    fieldKey(combo, function (c) {
      c.submit(true);
    });
  });
  fieldKey("escape", function (c) {
    if (!c.isWorking()) {
      return false;
    }
    c.deps.interrupt();
    return true;
  });

  function focusedComposer() {
    const pane = CC.Shell.focused();
    return pane != null ? CC.Composer.ofPane(pane.id) : null;
  }

  function selectedText() {
    const active = document.activeElement;
    if (active != null && active.selectionStart != null && active.selectionStart !== active.selectionEnd) {
      return true;
    }
    const selection = window.getSelection();
    return selection != null && !selection.isCollapsed;
  }

  // Back on this tab with focus nowhere, say after a click in the flow: the browser puts back only a focus it had. A selection stays, it
  // was probably made to be copied, and focusing the field would drop it.
  function comeBack() {
    const composer = document.hidden ? null : focusedComposer();
    const selection = window.getSelection();
    if (composer != null && (selection == null || selection.isCollapsed)) {
      composer.focusIfNowhere();
    }
  }

  // visibilitychange bubbles to the window, the one place outside CC.Keys it can be heard from.
  window.addEventListener("visibilitychange", comeBack);
  window.addEventListener("focus", comeBack);

  CC.Keys.bind("ctrl+c", {
    scope: "pane",
    when: function () {
      const c = focusedComposer();
      return c != null && c.isWorking() && !selectedText();
    },
    run: function () {
      focusedComposer().deps.interrupt();
    },
  });
})();
