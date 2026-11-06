// Typography and content width, on setting `typography`, applied as variables on the root, so every pane follows at once:
// --chat-font, --chat-size, --chat-lh, --mono, --code-size, --flow-width, and `data-code-scheme` when it isn't the theme's own.
CC.typography = (function () {
  const KEY = "typography";
  const DEFAULTS = { font: "sans", customFont: "", size: 14.5, lineHeight: 1.6, codeFont: "mono", customCodeFont: "", codeSize: 12.5, codeScheme: "theme", width: "md", renderMarkdown: true, breaks: false };
  const SANS = "var(--sans)";
  const SERIF = 'Georgia, "Times New Roman", serif';
  const MONO_FALLBACK = "ui-monospace, Menlo, Consolas, monospace";
  const FONTS = [["sans", "System sans", SANS], ["serif", "Serif", SERIF], ["mono", "Monospace", MONO_FALLBACK], ["custom", "Custom", null]];
  const WIDTHS = [["md", "Medium", "716px", "716 px"], ["lg", "Large", "980px", "980 px"], ["xl", "Extra large", "1240px", "1240 px"], ["fluid", "Fluid", "clamp(768px, 86%, 1280px)", "86% of the pane, 768 to 1280 px"]];
  const CODE_SCHEMES = [["theme", "Muxy theme"], ["intellij", "IntelliJ"], ["one-dark", "Material One Dark"]];
  const CODE_FONTS = [["mono", "System monospace", null], ["custom", "Custom", null]];
  const SHARED = ["--chat-font", "--chat-size", "--chat-lh", "--code-size", "--mono"];
  let current = Object.assign({}, DEFAULTS);
  let baseMono = null;
  let shareTimer = null;
  let installed = null;

  function family(name, fallback) {
    const n = (name || "").trim();
    if (n === "") {
      return fallback;
    }
    return (/[,"']/.test(n) ? n : '"' + n + '"') + ", " + fallback;
  }

  function mono() {
    if (baseMono == null) {
      baseMono = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || MONO_FALLBACK;
    }
    return baseMono;
  }

  function apply() {
    const s = current;
    const base = mono();
    const root = document.documentElement.style;
    const preset = FONTS.find(function (f) {
      return f[0] === s.font;
    });
    root.setProperty("--chat-font", s.font === "custom" ? family(s.customFont, SANS) : preset != null ? preset[2] : SANS);
    root.setProperty("--chat-size", s.size + "px");
    root.setProperty("--chat-lh", String(s.lineHeight));
    root.setProperty("--mono", s.codeFont === "custom" ? family(s.customCodeFont, base) : base);
    root.setProperty("--code-size", s.codeSize + "px");
    if (s.codeScheme !== "theme") {
      document.documentElement.dataset.codeScheme = s.codeScheme;
    } else {
      delete document.documentElement.dataset.codeScheme;
    }
    const width = WIDTHS.find(function (w) {
      return w[0] === s.width;
    });
    root.setProperty("--flow-width", width != null ? width[2] : WIDTHS[0][2]);
  }

  function load() {
    const v = CC.settings.get(KEY);
    current = Object.assign({}, DEFAULTS, v != null && typeof v === "object" ? v : {});
    apply();
    return current;
  }

  // Other extensions (ticket-board) read the resolved variables from ~/.config/claude-chat/typography.json.
  function share() {
    clearTimeout(shareTimer);
    shareTimer = setTimeout(function () {
      const root = document.documentElement.style;
      const vars = {};
      SHARED.forEach(function (name) {
        vars[name] = root.getPropertyValue(name);
      });
      Promise.resolve(CC.Servers.focused().host.call("saveTypography", { settings: current, vars: vars })).catch(function (e) {
        console.warn("typography share failed", e && e.message);
      });
    }, 400);
  }

  function store() {
    apply();
    share();
    return CC.settings.set(KEY, Object.assign({}, current));
  }

  function save(patch) {
    Object.assign(current, patch);
    return store();
  }

  // Width and renderMarkdown live in other sections, so the Typography reset keeps them.
  function reset() {
    current = Object.assign({}, DEFAULTS, { width: current.width, renderMarkdown: current.renderMarkdown });
    return store();
  }

  // Families installed on the Mac; empty when the server cannot ask it (no open-file bridge).
  function fonts() {
    if (installed == null) {
      installed = Promise.resolve(CC.Servers.focused().host.call("fonts", {})).then(function (r) {
        return r.fonts || [];
      }, function (e) {
        console.warn("font list failed", e && e.message);
        installed = null;
        return [];
      });
    }
    return installed;
  }

  CC.bus.on("app:ready", function () {
    load();
    window.addEventListener("focus", CC.settings.reload);
  });
  CC.bus.on("settings:changed", function (e) {
    if (e != null && e.key === KEY) {
      load();
    }
  });

  return {
    DEFAULTS: DEFAULTS, FONTS: FONTS, CODE_FONTS: CODE_FONTS, CODE_SCHEMES: CODE_SCHEMES, WIDTHS: WIDTHS, fonts: fonts, load: load, save: save, reset: reset,
    get: function () {
      return current;
    },
  };
})();
