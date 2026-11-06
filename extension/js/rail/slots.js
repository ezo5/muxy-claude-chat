// In the chat pane, beside C3's parts: the 5-hour bar and the context ring below the composer and, only near a limit, the banner above it.
(function () {
  const el = CC.util.el;
  const UI = CC.RailUi;
  const WARN_PCT = 80;
  const NEAR_PCT = 80;
  const SAME_RESET_S = 120;
  const RING_ORDER = 100;
  const BAR_ORDER = 90;
  const BAR_REPAINT_MS = 15000;
  const BANNER_ORDER = -10;

  CC.ChatPane.slot("belowComposer", function (host, ctx) {
    if (ctx.runtime == null) {
      return null;
    }
    const model = CC.RailData.of(ctx.runtime);
    const release = model.acquire();
    const button = el("button", "cc-ctx-ring");
    button.type = "button";
    const ring = CC.ui.ring(0);
    button.appendChild(ring);
    host.appendChild(button);
    let closePopover = null;

    function openPopover() {
      closePopover = UI.popover(button, function (box) {
        box.classList.add("cc-ctx-pop");
        box.appendChild(el("h3", "cc-usage-title", "Context"));
        const body = el("div");
        box.appendChild(body);
        const view = CC.RailContext.mount(body, ctx);
        return {
          unmount: function () {
            view.unmount();
            model.closeFull();
          },
        };
      });
    }

    button.addEventListener("click", function () {
      model.openFull();
      if (!CC.Rail.reveal("context")) {
        openPopover();
      }
    });

    function paint() {
      const c = model.context();
      button.hidden = c == null;
      if (c == null) {
        return;
      }
      ring.set(c.pct);
      button.classList.toggle("is-warn", c.pct >= WARN_PCT);
      const label = "Context: " + Math.round(c.pct) + "% used (" + CC.util.fmtTokens(c.used) + " of " + CC.util.fmtTokens(c.size) + ")";
      button.title = label;
      button.setAttribute("aria-label", label);
    }
    const off = model.on(paint);
    paint();
    return {
      unmount: function () {
        if (closePopover != null) {
          closePopover();
        }
        off();
        release();
      },
    };
  }, { order: RING_ORDER });

  // The 5-hour window as 2.x's strip showed it: bar against the pace tick, figure, time left; a click opens the details. Without a limit, as with API key
  // billing, or once the known window is over, there's nothing to say. The clock moves the tick and the time left, so it repaints without news too.
  function fiveHour(lim) {
    const five = lim != null ? lim.five : null;
    if (five == null || typeof five.pct !== "number" || (five.reset != null && five.reset <= Date.now() / 1000)) {
      return null;
    }
    return five;
  }

  CC.ChatPane.slot("belowComposer", function (host, ctx) {
    if (ctx.runtime == null) {
      return null;
    }
    const model = CC.RailData.of(ctx.runtime);
    const release = model.acquire();
    const button = el("button", "cc-usage-bar");
    button.type = "button";
    host.appendChild(button);
    let closePopover = null;
    let shown;

    button.addEventListener("click", function () {
      closePopover = UI.popover(button, function (box, close) {
        box.classList.add("cc-usage-pop");
        return CC.Usage.render(box, { runtime: ctx.runtime, close: close });
      });
    });

    function paint() {
      const five = fiveHour(model.limits());
      const left = five != null && five.reset != null ? UI.fmtLeft(five.reset) : "";
      const pace = five != null ? UI.paceOf(five.reset, UI.FIVE_H) : null;
      const signature = five != null ? JSON.stringify([Math.round(five.pct), left, pace != null ? Math.round(pace * 200) : null]) : null;
      if (signature === shown) {
        return;
      }
      shown = signature;
      button.hidden = five == null;
      if (five == null) {
        button.replaceChildren();
        return;
      }
      const pct = Math.round(five.pct);
      const label = "5-hour limit: " + pct + "% used" + (left !== "" ? ", resets in " + left : "");
      button.title = label;
      button.setAttribute("aria-label", label);
      button.replaceChildren(el("span", "cc-usage-bar-label", "Usage"), UI.meter(five.pct, pace), el("span", "cc-usage-bar-pct is-" + UI.level(five.pct, pace), pct + "%"));
      if (left !== "") {
        button.appendChild(el("span", "cc-usage-bar-left", "resets in " + left));
      }
    }

    const off = model.on(paint);
    const timer = setInterval(paint, BAR_REPAINT_MS);
    paint();
    return {
      unmount: function () {
        if (closePopover != null) {
          closePopover();
        }
        clearInterval(timer);
        off();
        release();
      },
    };
  }, { order: BAR_ORDER });

  // Limits are the account's, so a dismissal holds in every pane, until that window resets. Page-wide, kept in kv `ui/limitBanner`.
  const dismissals = {
    values: {},
    loaded: null,
    handlers: new Set(),
    load: function () {
      const self = this;
      if (this.loaded == null) {
        this.loaded = CC.Servers.appKv().get("ui", "limitBanner").then(function (v) {
          self.values = v || {};
          self.handlers.forEach(function (fn) {
            fn();
          });
        }, function (e) {
          console.warn("limit banner state not read", e && e.message);
        });
      }
      return this.loaded;
    },
    has: function (key, reset) {
      const at = this.values[key];
      return at != null && reset != null && Math.abs(at - reset) < SAME_RESET_S;
    },
    add: function (key, reset) {
      this.values[key] = reset;
      this.handlers.forEach(function (fn) {
        fn();
      });
      CC.Servers.appKv().set("ui", "limitBanner", this.values).catch(function (e) {
        console.warn("limit banner state not saved", e && e.message);
      });
    },
  };

  function nearest(lim) {
    if (lim == null) {
      return null;
    }
    const windows = [
      { key: "five", label: "5-hour limit", pct: lim.five.pct, reset: lim.five.reset },
      { key: "seven", label: "Weekly limit", pct: lim.seven.pct, reset: lim.seven.reset },
    ].filter(function (w) {
      return w.pct >= NEAR_PCT && !dismissals.has(w.key, w.reset);
    }).sort(function (a, b) {
      return b.pct - a.pct;
    });
    return windows.length > 0 ? windows[0] : null;
  }

  function bannerText(w) {
    const left = w.reset != null ? UI.fmtLeft(w.reset) : "";
    const state = w.pct >= 100 ? w.label + " reached." : w.label + " at " + Math.round(w.pct) + "%.";
    return state + (left !== "" ? " Resets in " + left + "." : "");
  }

  CC.ChatPane.slot("aboveComposer", function (host, ctx) {
    if (ctx.runtime == null) {
      return null;
    }
    const model = CC.RailData.of(ctx.runtime);
    const release = model.acquire();
    let closePopover = null;
    let shown = null;

    function details(anchor) {
      closePopover = UI.popover(anchor, function (box) {
        box.classList.add("cc-usage-pop");
        return CC.Usage.render(box, { runtime: ctx.runtime, close: function () {
          if (closePopover != null) {
            closePopover();
          }
        } });
      });
    }

    function paint() {
      const w = nearest(model.limits());
      const signature = w != null ? bannerText(w) : null;
      if (signature === shown) {
        return;
      }
      shown = signature;
      host.replaceChildren();
      if (w == null) {
        return;
      }
      const banner = el("div", "cc-limit-banner");
      banner.setAttribute("role", "status");
      banner.appendChild(el("span", "cc-limit-banner-text", signature));
      const more = CC.ui.chip({
        label: "Details",
        onClick: function () {
          details(more);
        },
      });
      banner.appendChild(more);
      banner.appendChild(CC.ui.iconButton({
        icon: "x",
        size: 14,
        label: "Dismiss until this limit resets",
        onClick: function () {
          dismissals.add(w.key, w.reset);
        },
      }));
      host.appendChild(banner);
    }

    dismissals.handlers.add(paint);
    dismissals.load();
    const off = model.on(paint);
    paint();
    return {
      unmount: function () {
        if (closePopover != null) {
          closePopover();
        }
        dismissals.handlers.delete(paint);
        off();
        release();
      },
    };
  }, { order: BANNER_ORDER });
})();
