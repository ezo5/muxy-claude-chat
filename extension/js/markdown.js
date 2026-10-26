window.CC = window.CC || {};

CC.markdown = (function () {
  const util = CC.util;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  const ALIASES = { sh: "bash", zsh: "bash", console: "bash", shell: "bash", js: "javascript", ts: "typescript", tsx: "typescript", jsx: "javascript", py: "python", yml: "yaml", html: "xml", vue: "xml", kt: "kotlin", rs: "rust", "c++": "cpp", jsonc: "json", json5: "json", patch: "diff", text: "plaintext", txt: "plaintext" };

  function langOf(lang) {
    const l = String(lang || "").trim().split(/\s+/)[0].toLowerCase();
    return ALIASES[l] || l;
  }

  function highlight(code, lang) {
    const l = langOf(lang);
    if (window.hljs != null && l && l !== "plaintext" && hljs.getLanguage(l) != null && code.length < 200000) {
      try {
        return hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
      } catch (e) {
        return escapeHtml(code);
      }
    }
    return escapeHtml(code);
  }

  const renderer = {
    html: function (token) {
      return escapeHtml(token.text || token.raw || "");
    },
    code: function (token) {
      const lang = langOf(token.lang);
      return '<div class="code-block" data-lang="' + escapeHtml(lang || "") + '"><div class="code-head"><span class="code-lang">' +
        escapeHtml(lang || "code") + '</span></div><pre><code class="hljs">' + highlight(token.text, lang) + "</code></pre></div>";
    },
    link: function (token) {
      const text = this.parser.parseInline(token.tokens);
      return '<a href="#" data-href="' + escapeHtml(token.href || "") + '" title="' + escapeHtml(token.href || "") + '">' + text + "</a>";
    },
    codespan: function (token) {
      const raw = token.raw.replace(/^`+|`+$/g, "").trim();
      const text = escapeHtml(raw);
      if (!isPath(raw)) {
        return "<code>" + text + "</code>";
      }
      return '<code class="path-link" data-path="' + text + '" title="' + text + '&#10;Click to open (Cmd+click copies)">' + escapeHtml(displayPath(raw)) + "</code>";
    },
    image: function (token) {
      return '<span class="md-image" title="' + escapeHtml(token.href || "") + '">[image: ' + escapeHtml(token.text || token.href || "") + "]</span>";
    },
  };

  let renderCwd = "";

  function displayPath(raw) {
    const p = raw.replace(/^file:\/\//, "");
    if (p.charAt(0) !== "/") {
      return raw;
    }
    const s = util.shortPath(p, renderCwd);
    const parts = s.split("/");
    return s.length > 48 && parts.length > 4 ? "…/" + parts.slice(-3).join("/") : s;
  }

  function isPath(text) {
    return /^(file:\/\/)?\.{0,2}\/?[\w.@~+-]+(\/[\w.@~+-]+)+(:\d+){0,2}$/.test(text) || /^\/[\w.@~+-]+(\/[\w.@~+-]+)*(:\d+){0,2}$/.test(text);
  }

  const OPEN_WITH = [
    { app: "zed", label: "Open in Zed" },
    { app: "idea", label: "Open in IntelliJ" },
    { app: "finder", label: "Reveal in Finder" },
  ];

  function closeMenu() {
    const old = document.getElementById("path-menu");
    if (old != null) {
      old.remove();
    }
  }

  async function copy(target) {
    const ok = await util.copyText(target);
    util.toast(ok ? "Copied" : "Copy failed", ok ? null : "error");
  }

  async function openWith(target, app, label) {
    try {
      await CC.openPath(target, app);
    } catch (err) {
      util.toast(label + " failed: " + (err && err.message), "error");
    }
  }

  function pathItems(target) {
    return OPEN_WITH.map(function (o) {
      return { label: o.label, run: function () { openWith(target, o.app, o.label); } };
    }).concat([{ label: "Copy path", run: function () { copy(target); } }]);
  }

  async function openUrl(url, where) {
    try {
      if (where === "muxy") {
        await muxy.tabs.open({ kind: "browser", url: url });
      } else {
        await CC.host.reader("openUrl", { url: url });
      }
    } catch (err) {
      util.toast("Open failed: " + (err && err.message), "error");
    }
  }

  function urlItems(url) {
    return [
      { label: "Open in Muxy browser", run: function () { openUrl(url, "muxy"); } },
      { label: "Open in default browser", run: function () { openUrl(url, "host"); } },
      { label: "Copy link", run: function () { copy(url); } },
    ];
  }

  function showMenu(e, items) {
    closeMenu();
    const menu = util.el("div", "path-menu");
    menu.id = "path-menu";
    items.forEach(function (o) {
      const b = util.el("button", "path-menu-item", o.label);
      b.addEventListener("click", function () {
        closeMenu();
        o.run();
      });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - r.width - 4)) + "px";
    menu.style.top = (e.clientY + r.height + 8 > window.innerHeight ? e.clientY - r.height - 4 : e.clientY + 4) + "px";
    setTimeout(function () {
      document.addEventListener("mousedown", function away(ev) {
        if (!menu.contains(ev.target)) {
          closeMenu();
          document.removeEventListener("mousedown", away);
        }
      });
    });
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      closeMenu();
    }
  });

  function openOrCopy(e, href) {
    e.preventDefault();
    const target = String(href).replace(/#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/, function (m, line, col) {
      return ":" + line + (col ? ":" + col : "");
    });
    if (!e.metaKey && /^https?:\/\//i.test(target) && window.muxy != null) {
      showMenu(e, urlItems(target));
      return;
    }
    if (e.metaKey || !isPath(target) || CC.openPath == null) {
      copy(target);
      return;
    }
    showMenu(e, pathItems(target));
  }

  let ready = false;
  function setup() {
    if (ready || window.marked == null) {
      return;
    }
    marked.use({ gfm: true, breaks: false, renderer: renderer });
    ready = true;
  }

  function enhance(root) {
    root.querySelectorAll(".code-block").forEach(function (block) {
      const pre = block.querySelector("pre");
      const head = block.querySelector(".code-head");
      head.appendChild(util.copyButton(function () {
        return pre.textContent;
      }));
    });
    root.querySelectorAll("table").forEach(function (t) {
      const wrap = util.el("div", "table-wrap");
      t.parentNode.insertBefore(wrap, t);
      wrap.appendChild(t);
    });
    root.querySelectorAll("a[data-href]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        openOrCopy(e, a.getAttribute("data-href"));
      });
    });
    root.querySelectorAll("code.path-link").forEach(function (c) {
      c.addEventListener("click", function (e) {
        openOrCopy(e, c.getAttribute("data-path"));
      });
    });
    root.querySelectorAll("li > input[type=checkbox]").forEach(function (box) {
      box.disabled = true;
      box.parentNode.classList.add("task-item");
    });
  }

  function render(text, opts) {
    setup();
    renderCwd = (opts && opts.cwd) || "";
    const div = util.el("div", "md");
    if (!ready) {
      div.textContent = text;
      div.style.whiteSpace = "pre-wrap";
      return div;
    }
    try {
      div.innerHTML = marked.parse(text);
    } catch (e) {
      div.textContent = text;
      div.style.whiteSpace = "pre-wrap";
      return div;
    }
    enhance(div);
    return div;
  }

  function codeBlock(code, lang, opts) {
    const o = opts || {};
    const wrap = util.el("div", "code-block" + (o.compact ? " compact" : ""));
    const pre = util.el("pre");
    const c = util.el("code", "hljs");
    c.innerHTML = highlight(code, lang);
    pre.appendChild(c);
    if (o.head !== false) {
      const head = util.el("div", "code-head");
      head.appendChild(util.el("span", "code-lang", o.title || langOf(lang) || "output"));
      head.appendChild(util.copyButton(function () {
        return code;
      }));
      wrap.appendChild(head);
    }
    wrap.appendChild(pre);
    return wrap;
  }

  // A file's content; .md files also get a rendered view, shown per Settings → General and flipped in the header.
  function fileBlock(code, path, opts) {
    const lang = langFromPath(path);
    const block = codeBlock(code, lang, opts);
    if (lang !== "markdown") {
      return block;
    }
    const doc = render(code, opts);
    doc.classList.add("md-file");
    block.appendChild(doc);
    const btn = util.el("button", "copy-btn code-toggle");
    btn.type = "button";
    function show(rendered) {
      block.classList.toggle("md-rendered", rendered);
      btn.textContent = rendered ? "Source" : "Preview";
    }
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      show(!block.classList.contains("md-rendered"));
    });
    const head = block.querySelector(".code-head");
    head.insertBefore(btn, head.lastChild);
    show(CC.typography.get().renderMarkdown);
    return block;
  }

  function langFromPath(path) {
    const m = /\.([A-Za-z0-9+]+)$/.exec(path || "");
    if (m == null) {
      return "";
    }
    const ext = m[1].toLowerCase();
    const map = { md: "markdown", java: "java", ts: "typescript", js: "javascript", mjs: "javascript", cjs: "javascript", py: "python", rs: "rust", sql: "sql", json: "json", yml: "yaml", yaml: "yaml", html: "xml", xml: "xml", css: "css", scss: "scss", less: "less", sh: "bash", kt: "kotlin", go: "go", gradle: "gradle", groovy: "groovy", properties: "properties", toml: "ini", ini: "ini", swift: "swift", rb: "ruby", php: "php", c: "c", h: "c", cpp: "cpp", cs: "csharp", lua: "lua", dockerfile: "dockerfile", vue: "xml", svg: "xml", tsx: "typescript", jsx: "javascript" };
    return map[ext] || "";
  }

  return { render: render, codeBlock: codeBlock, fileBlock: fileBlock, highlight: highlight, escapeHtml: escapeHtml, langFromPath: langFromPath };
})();
