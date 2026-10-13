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

  function icon(name) {
    const span = el("span", "icon icon-" + name);
    span.innerHTML = CC.icons[name] || "";
    return span;
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
      return s + "s";
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
      return m + "m " + (s % 60) + "s";
    }
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
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

  function screenNorm(s) {
    return (s || "").replace(/[\s─-╿│❯>]+/g, "");
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

  function copyButton(getText, label) {
    const btn = el("button", "copy-btn");
    btn.type = "button";
    btn.title = "Copy";
    btn.appendChild(icon("copy"));
    if (label) {
      btn.appendChild(el("span", null, label));
    }
    btn.addEventListener("click", async function (e) {
      e.stopPropagation();
      const ok = await copyText(getText());
      btn.classList.add(ok ? "copied" : "copy-failed");
      setTimeout(function () {
        btn.classList.remove("copied", "copy-failed");
      }, 1200);
    });
    return btn;
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
    return p.replace(/^\/home\/[^/]+\//, "~/");
  }

  function firstLine(s, max) {
    const line = String(s || "").split("\n")[0];
    const n = max || 160;
    return line.length > n ? line.slice(0, n) + "…" : line;
  }

  function modelLabel(meta, effort) {
    const e = effort || meta.effort;
    return (meta.model || "") + (e ? " [" + e + "]" : "");
  }

  function branchChip(branch, cls) {
    const c = el("span", cls);
    c.appendChild(icon("branch"));
    c.appendChild(el("span", null, branch));
    c.title = "Git branch";
    return c;
  }

  function toast(text, kind) {
    let host = document.getElementById("toasts");
    if (host == null) {
      host = el("div");
      host.id = "toasts";
      document.body.appendChild(host);
    }
    const isError = kind === "error";
    const t = el("div", isError ? "toast error" : "toast");
    t.appendChild(el("span", "toast-text", text));
    let ms = 3000;
    if (isError) {
      const ts = new Date().toISOString();
      const title = (document.getElementById("title") || {}).textContent || "";
      const entry = "[" + ts + "] " + (title ? title + ": " : "") + text;
      console.warn("[chat-error] " + entry);
      if (CC.host != null) {
        CC.host.reader("logError", { text: entry }).catch(function () {});
      }
      t.appendChild(copyButton(function () {
        return entry;
      }));
      ms = 8000;
    }
    host.appendChild(t);
    setTimeout(function () {
      t.classList.add("out");
    }, ms - 400);
    setTimeout(function () {
      t.remove();
    }, ms);
  }

  return {
    el: el, icon: icon, sleep: sleep, fmtTime: fmtTime, fmtDuration: fmtDuration, fmtTokens: fmtTokens,
    screenNorm: screenNorm, copyText: copyText, copyButton: copyButton, uid: uid, uuid: uuid, shortPath: shortPath,
    firstLine: firstLine, toast: toast, modelLabel: modelLabel, branchChip: branchChip,
  };
})();
