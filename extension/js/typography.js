window.CC = window.CC || {};

// Chat typography stored in muxy.storage (shared by all chat tabs) and applied as CSS variables on :root.
CC.typography = (function () {
  const KEY = "settings:typography";
  const DEFAULTS = { font: "sans", customFont: "", size: 14.5, lineHeight: 1.6, codeFont: "mono", customCodeFont: "", codeSize: 12.5, width: "md", renderMarkdown: true };
  const FONTS = [["sans", "System sans", "var(--sans)"], ["serif", "Serif", "var(--serif)"], ["mono", "Monospace", "var(--mono)"], ["custom", "Custom…", null]];
  const WIDTHS = [["md", "MD", "768px"], ["lg", "LG", "980px"], ["xl", "XL", "1240px"]];
  const CODE_FONTS = [["mono", "System monospace", null], ["custom", "Custom…", null]];
  const MONO = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim();
  let current = Object.assign({}, DEFAULTS);

  function family(name, fallback) {
    const n = (name || "").trim();
    if (n === "") {
      return fallback;
    }
    return (/[,"']/.test(n) ? n : '"' + n + '"') + ", " + fallback;
  }

  function apply() {
    const s = current;
    const root = document.documentElement.style;
    const preset = FONTS.find(function (f) {
      return f[0] === s.font;
    });
    root.setProperty("--chat-font", s.font === "custom" ? family(s.customFont, "var(--sans)") : preset != null ? preset[2] : "var(--sans)");
    root.setProperty("--chat-size", s.size + "px");
    root.setProperty("--chat-lh", String(s.lineHeight));
    root.setProperty("--mono", s.codeFont === "custom" ? family(s.customCodeFont, MONO) : MONO);
    root.setProperty("--code-size", s.codeSize + "px");
    const width = WIDTHS.find(function (w) {
      return w[0] === s.width;
    });
    root.setProperty("--content", width != null ? width[2] : WIDTHS[0][2]);
  }

  async function load() {
    const v = await CC.host.storageGet(KEY);
    current = Object.assign({}, DEFAULTS, v != null && typeof v === "object" ? v : {});
    apply();
    return current;
  }

  async function save(patch) {
    Object.assign(current, patch);
    apply();
    await CC.host.storageSet(KEY, current);
    share();
  }

  // Width and renderMarkdown live in other sections, so the Typography reset keeps them.
  async function reset() {
    current = Object.assign({}, DEFAULTS, { width: current.width, renderMarkdown: current.renderMarkdown });
    apply();
    await CC.host.storageSet(KEY, current);
    share();
  }

  // Other extensions (ticket-board) read the resolved variables from ~/.config/claude-chat/typography.json.
  let shareTimer = null;
  function share() {
    clearTimeout(shareTimer);
    shareTimer = setTimeout(function () {
      const root = document.documentElement.style;
      const vars = {};
      ["--chat-font", "--chat-size", "--chat-lh", "--code-size", "--mono"].forEach(function (name) {
        vars[name] = root.getPropertyValue(name);
      });
      CC.host.reader("saveTypography", { settings: current, vars: vars }).catch(function (e) {
        console.warn("typography share failed", e && e.message);
      });
    }, 400);
  }

  // Families installed on the Mac; empty when the server cannot ask it (no open-file bridge).
  let installed = null;
  function fonts() {
    if (installed == null) {
      installed = CC.host.reader("fonts", {}).then(function (r) {
        return r.fonts || [];
      }, function (e) {
        console.warn("font list failed", e && e.message);
        installed = null;
        return [];
      });
    }
    return installed;
  }

  // Another chat tab may have changed the settings while this one was hidden.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      load();
    }
  });

  apply();

  return {
    DEFAULTS: DEFAULTS,
    FONTS: FONTS,
    CODE_FONTS: CODE_FONTS,
    WIDTHS: WIDTHS,
    fonts: fonts,
    load: load,
    save: save,
    reset: reset,
    get: function () {
      return current;
    },
  };
})();
