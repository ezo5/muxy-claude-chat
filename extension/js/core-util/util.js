window.CC = window.CC || {};

CC.util = (function () {
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) {
      node.className = cls;
    }
    if (text != null) {
      node.textContent = text;
    }
    return node;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function fmtTime(ts) {
    if (!ts) {
      return "";
    }
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === now.toDateString()) {
      return time;
    }
    return d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + time;
  }

  function fmtDuration(ms) {
    if (ms == null) {
      return "";
    }
    const s = Math.round(ms / 1000);
    if (s < 60) {
      return s + " s";
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
      return m + " min " + (s % 60) + " s";
    }
    return Math.floor(m / 60) + " h " + (m % 60) + " min";
  }

  function fmtTokens(n) {
    if (n == null) {
      return "";
    }
    if (n >= 1000000) {
      return (n / 1000000).toFixed(1) + "M";
    }
    if (n >= 1000) {
      return Math.round(n / 1000) + "k";
    }
    return String(n);
  }

  function fmtCost(usd) {
    return "$" + (usd > 0 && usd < 0.01 ? usd.toFixed(3) : (usd || 0).toFixed(2));
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard != null && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      console.warn("clipboard api failed", e && e.message);
    }
    const ta = el("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // `claude --session-id` wants a v4 UUID; crypto.randomUUID is missing on insecure origins (dev harness over http).
  function uuid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 3) | 8).toString(16);
    });
  }

  function shortPath(p, cwd) {
    if (p == null) {
      return "";
    }
    if (cwd && p.indexOf(cwd + "/") === 0) {
      return p.slice(cwd.length + 1);
    }
    return p.replace(/^\/(home|Users)\/[^/]+\//, "~/");
  }

  function firstLine(s, max) {
    const line = String(s || "").split("\n")[0];
    const n = max || 160;
    return line.length > n ? line.slice(0, n) + "…" : line;
  }

  // "claude-opus-5-5" → "Opus 5.5"; other ids stay as they are.
  function prettyModel(id) {
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
    if (m == null) {
      return id;
    }
    return m[1].charAt(0).toUpperCase() + m[1].slice(1) + " " + m[2] + (m[3] ? "." + m[3] : "");
  }

  return {
    el: el, sleep: sleep, fmtTime: fmtTime, fmtDuration: fmtDuration, fmtTokens: fmtTokens, fmtCost: fmtCost, copyText: copyText,
    uid: uid, uuid: uuid, shortPath: shortPath, firstLine: firstLine, prettyModel: prettyModel,
  };
})();
