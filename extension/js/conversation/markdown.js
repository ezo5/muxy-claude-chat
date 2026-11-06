// Markdown to elements. Streaming through Live keeps the DOM of finished blocks, so selections and code blocks survive.
// Clicks on paths, links and images are delegated: a view calls CC.links.bind(root, getCtx) once.
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

  function Lru(max) {
    this.max = max;
    this.map = new Map();
  }

  Lru.prototype.get = function (k) {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  };

  Lru.prototype.set = function (k, v) {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value);
    }
  };

  const highlighted = new Lru(300);
  const htmlCache = new Lru(300);

  function highlight(code, lang) {
    const l = langOf(lang);
    if (window.hljs != null && l && l !== "plaintext" && window.hljs.getLanguage(l) != null && code.length < 200000) {
      const key = l + "\0" + code;
      let html = highlighted.get(key);
      if (html === undefined) {
        try {
          html = window.hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
        } catch (e) {
          html = escapeHtml(code);
        }
        highlighted.set(key, html);
      }
      return html;
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
      if (!CC.links.isPath(raw)) {
        return "<code>" + text + "</code>";
      }
      return '<code class="path-link" data-path="' + text + '" title="' + text + '&#10;Click to open (Cmd+click copies)">' + escapeHtml(displayPath(raw)) + "</code>";
    },
    image: function (token) {
      if (/^(https:\/\/|data:image\/)/i.test(token.href || "")) {
        return '<img class="md-img" src="' + escapeHtml(token.href) + '" alt="' + escapeHtml(token.text || "") + '" title="' + escapeHtml(token.title || token.text || "") + '" loading="lazy">';
      }
      return '<span class="md-image" title="' + escapeHtml(token.href || "") + '">[image: ' + escapeHtml(token.text || token.href || "") + "]</span>";
    },
  };

  // Set only for the length of one synchronous render, read by the renderer above.
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

  // GFM strikes text between single tildes ("~5 min … ~10 s"); only ~~x~~ counts here.
  const DEL = /^~~(?=[^\s~])([\s\S]*?\S)~~(?!~)/;
  // Any balanced **x** is bold, also where CommonMark's flanking rule leaves the stars literal ("**Note:**text").
  const STRONG = /^\*\*(?![\s*])([^*\n]*?[^\s*])\*\*(?!\*)/;

  const tokenizer = {
    del: function (src) {
      const m = DEL.exec(src);
      return m != null ? { type: "del", raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) } : undefined;
    },
  };

  const looseStrong = {
    name: "looseStrong",
    level: "inline",
    start: function (src) {
      const i = src.indexOf("**");
      return i >= 0 ? i : undefined;
    },
    tokenizer: function (src) {
      const m = STRONG.exec(src);
      return m != null ? { type: "strong", raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) } : undefined;
    },
  };

  let ready = false;
  let breaks = false;

  // Setting `typography`, C4's.
  function typography() {
    return (CC.settings != null ? CC.settings.get("typography") : null) || {};
  }

  function setup() {
    const marked = window.marked;
    if (marked == null) {
      return;
    }
    if (!ready) {
      marked.use({ gfm: true, breaks: false, renderer: renderer, tokenizer: tokenizer, extensions: [looseStrong] });
      ready = true;
    }
    const b = typography().breaks === true;
    if (b !== breaks) {
      breaks = b;
      marked.setOptions({ breaks: b });
      htmlCache.map.clear();
    }
  }

  const TEXT_PATH = /(^|[\s(\[{"'“‘])((?:~|file:\/\/)?\/[\w.@~+-]+(?:\/[\w.@~+-]+)+(?::\d+){0,2})/g;

  // Absolute paths in prose get the path link of inline code; the text stays as written.
  function linkPaths(root) {
    const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        return n.parentNode.closest("pre, code, a, .path-link") == null && n.nodeValue.indexOf("/") >= 0 ? window.NodeFilter.FILTER_ACCEPT : window.NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }
    nodes.forEach(function (node) {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let at = 0;
      TEXT_PATH.lastIndex = 0;
      let m;
      while ((m = TEXT_PATH.exec(text)) != null) {
        const p = m[2].replace(/[.,;:]+$/, "");
        const start = m.index + m[1].length;
        frag.appendChild(document.createTextNode(text.slice(at, start)));
        const span = util.el("span", "path-link", p);
        span.dataset.path = p;
        span.title = p + "\nClick to open (Cmd+click copies)";
        frag.appendChild(span);
        at = start + p.length;
        TEXT_PATH.lastIndex = at;
      }
      if (at > 0) {
        frag.appendChild(document.createTextNode(text.slice(at)));
        node.replaceWith(frag);
      }
    });
  }

  // Markdown in a code block, a file's or a fenced one: shown rendered per the renderMarkdown setting, flipped in its header, its copy button keeping the source.
  function addPreview(block, code, opts) {
    const doc = render(code, opts);
    doc.classList.add("md-file");
    block.appendChild(doc);
    const btn = util.el("button", "code-toggle");
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
    show(typography().renderMarkdown !== false);
  }

  function enhance(root) {
    linkPaths(root);
    root.querySelectorAll(".code-block").forEach(function (block) {
      const pre = block.querySelector("pre");
      block.querySelector(".code-head").appendChild(CC.conv.copyButton(function () {
        return pre.textContent;
      }));
    });
    root.querySelectorAll("table").forEach(function (t) {
      const wrap = util.el("div", "table-wrap");
      t.parentNode.insertBefore(wrap, t);
      wrap.appendChild(t);
    });
    root.querySelectorAll("li > input[type=checkbox]").forEach(function (box) {
      box.disabled = true;
      box.parentNode.classList.add("task-item");
    });
    // Last: what it renders is already enhanced, and the steps above would do it again.
    const cwd = renderCwd;
    root.querySelectorAll('.code-block[data-lang="markdown"]').forEach(function (block) {
      addPreview(block, block.querySelector("pre").textContent, { cwd: cwd });
      block.classList.add("md-fence");
    });
  }

  function plain(div, text) {
    div.textContent = text;
    div.style.whiteSpace = "pre-wrap";
    return div;
  }

  function cached(key, make) {
    let html = htmlCache.get(key);
    if (html === undefined) {
      html = make();
      htmlCache.set(key, html);
    }
    return html;
  }

  function render(text, opts) {
    setup();
    renderCwd = (opts && opts.cwd) || "";
    const div = util.el("div", "md");
    if (!ready) {
      return plain(div, text);
    }
    try {
      div.innerHTML = cached("doc\0" + renderCwd + "\0" + text, function () {
        return window.marked.parse(text);
      });
    } catch (e) {
      return plain(div, text);
    }
    enhance(div);
    return div;
  }

  const FENCE_END = /\n {0,3}(`{3,}|~{3,})[ \t]*\n*$/;

  // A closing fence still arriving shows as a stray "`" line in the open block until it is complete.
  function openFence(token) {
    if (token.type !== "code" || token.codeBlockStyle === "indented" || FENCE_END.test(token.raw)) {
      return token;
    }
    const lines = token.text.split("\n");
    if (lines.length === 0 || !/^ {0,3}[`~]+$/.test(lines[lines.length - 1])) {
      return token;
    }
    return Object.assign({}, token, { text: lines.slice(0, -1).join("\n") });
  }

  // Streaming text: the DOM of every top-level token whose source is unchanged stays (selection, hover state, code
  // blocks); only the tokens from the first changed one on are rendered again. A token's trailing newline moves to
  // the next token once more text arrives, so it does not count.
  function Live(opts) {
    this.cwd = (opts && opts.cwd) || "";
    this.root = util.el("div", "md");
    this.blocks = [];
  }

  function blockKey(token) {
    return token.type + "\0" + token.raw.replace(/\n+$/, "");
  }

  Live.prototype.set = function (text, final) {
    setup();
    renderCwd = this.cwd;
    let tokens = null;
    try {
      tokens = ready ? window.marked.lexer(text) : null;
    } catch (e) {
      tokens = null;
    }
    if (tokens == null) {
      this.blocks = [];
      plain(this.root, text);
      return;
    }
    this.root.style.whiteSpace = "";
    if (this.blocks.length === 0) {
      this.root.textContent = "";
    }
    const links = tokens.links || {};
    let k = 0;
    while (k < tokens.length && k < this.blocks.length && this.blocks[k].key === blockKey(tokens[k])) {
      k++;
    }
    this.blocks.slice(k).forEach(function (b) {
      b.nodes.forEach(function (n) {
        n.remove();
      });
    });
    this.blocks.length = k;
    const tmp = document.createElement("div");
    for (let i = k; i < tokens.length; i++) {
      const token = final || i < tokens.length - 1 ? tokens[i] : openFence(tokens[i]);
      const one = [token];
      one.links = links;
      try {
        tmp.innerHTML = window.marked.parser(one);
      } catch (e) {
        tmp.textContent = token.raw;
      }
      enhance(tmp);
      const nodes = Array.prototype.slice.call(tmp.childNodes);
      this.root.append.apply(this.root, nodes);
      this.blocks.push({ key: token === tokens[i] ? blockKey(token) : null, nodes: nodes });
    }
    // Kept blocks can differ from a fresh parse (reference links defined later), so the final text is checked once.
    if (final) {
      const full = render(text, { cwd: this.cwd });
      if (full.innerHTML !== this.root.innerHTML) {
        this.blocks = [];
        this.root.replaceChildren.apply(this.root, Array.prototype.slice.call(full.childNodes));
      }
    }
  };

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
      head.appendChild(CC.conv.copyButton(function () {
        return code;
      }));
      wrap.appendChild(head);
    }
    wrap.appendChild(pre);
    return wrap;
  }

  // A file's content; .md files also get a rendered view, shown per the renderMarkdown setting and flipped in the header.
  function fileBlock(code, path, opts) {
    const lang = langFromPath(path);
    const block = codeBlock(code, lang, opts);
    if (lang !== "markdown") {
      return block;
    }
    addPreview(block, code, opts);
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

  return { render: render, Live: Live, codeBlock: codeBlock, fileBlock: fileBlock, highlight: highlight, escapeHtml: escapeHtml, langFromPath: langFromPath };
})();
