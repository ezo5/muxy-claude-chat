// Chat or terminal, on the chat pane: the header control, Ctrl+backtick, and the bar that stands in for the composer while the
// conversation runs in a terminal tab. The logic is CC.Modes; this only asks the runtime. Wraps the W0 pane kind, because a real
// factory in the `composer` slot would push out what fills it.
(function () {
  CC.icons.chat = '<path d="M21 12a8 8 0 0 1-8 8H4l2.3-3A8 8 0 1 1 21 12z"/>';

  function stateOf(rt) {
    return rt.modeState != null ? rt.modeState() : { mode: rt.mode(), switching: null, tuiGone: false, paneId: null };
  }

  async function toggle(rt) {
    const toTerminal = rt.mode() !== "terminal";
    try {
      await (toTerminal ? rt.toTerminal() : rt.toChat());
    } catch (e) {
      console.warn("mode switch failed", e);
      CC.ui.toast((toTerminal ? "Couldn't open the terminal: " : "Couldn't return to the chat: ") + (e && e.message ? e.message : e), { level: "error" });
      // Going to the terminal stops the daemon first, so a refused terminal would leave a chat that can't answer.
      if (toTerminal && rt.status() === "stopped" && rt.mode() !== "terminal") {
        rt.restart({ resume: true }).catch(function (err) {
          console.warn("chat not restarted", err && err.message);
        });
      }
    }
  }

  function modeActions(ctx) {
    const rt = ctx.runtime;
    if (rt == null) {
      return [];
    }
    const inTerminal = rt.mode() === "terminal";
    return [
      { icon: "chat", label: "Chat here (Ctrl+`)", on: !inTerminal, cls: "cc-mode-seg", run: function () {
        if (inTerminal) {
          toggle(rt);
        }
      } },
      { icon: "terminal", label: "Continue in a terminal (Ctrl+`)", on: inTerminal, cls: "cc-mode-seg", run: function () {
        if (!inTerminal) {
          toggle(rt);
        }
      } },
    ];
  }

  function barText(st) {
    if (st.switching === "toTerminal") {
      return "Opening the terminal.";
    }
    if (st.switching === "toChat") {
      return "Returning to the chat.";
    }
    return st.tuiGone === true ? "Claude has left the terminal." : "This chat is running in the terminal.";
  }

  function renderBar(bar, rt) {
    const st = stateOf(rt);
    bar.replaceChildren(CC.util.el("span", "cc-mode-bar-text", barText(st)));
    if (st.switching != null) {
      return;
    }
    const model = rt.meta() != null ? rt.meta().model : null;
    if (model) {
      bar.appendChild(CC.ui.chip({ label: model }));
    }
    if (st.paneId != null && st.tuiGone !== true) {
      bar.appendChild(CC.ui.button({ label: "Show terminal", onClick: function () {
        Promise.resolve(CC.host.terminal.focus(st.paneId)).catch(function (e) {
          CC.ui.toast("Couldn't show the terminal: " + e.message, { level: "error" });
        });
      } }));
    }
    bar.appendChild(CC.ui.button({ label: "Continue here", primary: true, onClick: function () {
      toggle(rt);
    } }));
  }

  // The frame's slots stay mounted, so a draft is still there afterwards.
  function attachBar(el, ctx) {
    const rt = ctx.runtime;
    if (rt == null) {
      return function () {};
    }
    const bar = CC.util.el("div", "cc-mode-bar");
    bar.hidden = true;
    const composer = el.querySelector(".cc-slot-composer");
    if (composer != null) {
      composer.parentNode.insertBefore(bar, composer);
    } else {
      el.appendChild(bar);
    }
    function refresh() {
      const st = stateOf(rt);
      const locked = st.mode === "terminal" || st.switching != null;
      el.classList.toggle("cc-chat-locked", locked);
      bar.hidden = !locked;
      if (locked) {
        renderBar(bar, rt);
      }
      ctx.setTitle();
    }
    const off = rt.on("mode", refresh);
    // A chat restored to terminal mode may have said so before this pane existed.
    const st = stateOf(rt);
    if (st.mode === "terminal" || st.switching != null) {
      el.classList.add("cc-chat-locked");
      bar.hidden = false;
      renderBar(bar, rt);
    }
    return function () {
      off();
      bar.remove();
    };
  }

  function isToggleKey(e) {
    return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === "`" || e.code === "Backquote");
  }

  const base = CC.Panes.get("chat");
  CC.Panes.register("chat", Object.assign({}, base, {
    actions: function (ctx) {
      return modeActions(ctx).concat(base.actions != null ? base.actions(ctx) : []);
    },
    mount: function (el, ctx) {
      const handle = base.mount(el, ctx) || {};
      const detach = attachBar(el, ctx);
      return Object.assign({}, handle, {
        unmount: function () {
          detach();
          if (handle.unmount != null) {
            handle.unmount();
          }
        },
        onKey: function (e) {
          if (handle.onKey != null && handle.onKey(e) === true) {
            return true;
          }
          if (ctx.runtime != null && isToggleKey(e)) {
            toggle(ctx.runtime);
            return true;
          }
          return false;
        },
      });
    },
  }));
})();
