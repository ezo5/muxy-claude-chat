// What Review computes without touching a pane's state: word diffs, context expansion, split rows, whitespace filtering, file groups,
// signatures and the message sent to Claude.
CC.reviewDiff = (function () {
  const el = CC.util.el;
  const WORKTREE_ID = "worktree";
  const WORKTREE_LABEL = "the uncommitted changes";
  const LCS_CELLS = 40000;
  const SHOW_TEXT = 4;

  function anchorKey(src, path, sign, line) {
    return src + "\n" + path + "\n" + sign + line;
  }

  function keyOf(c) {
    return anchorKey(c.src || WORKTREE_ID, c.path, c.sign, c.line);
  }

  function pathOfKey(key) {
    return key.split("\n")[1];
  }

  function lcsTable(x, y) {
    const t = [];
    for (let i = x.length; i >= 0; i--) {
      t[i] = new Uint16Array(y.length + 1);
      for (let j = y.length - 1; i < x.length && j >= 0; j--) {
        t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
      }
    }
    return t;
  }

  // Changed words of a paired removed / added line, or null when the lines have too little in common.
  function wordDiff(a, b) {
    const x = a.match(/\w+|\s+|[^\w\s]/g) || [];
    const y = b.match(/\w+|\s+|[^\w\s]/g) || [];
    if (x.length * y.length > LCS_CELLS || x.length === 0 || y.length === 0) {
      return null;
    }
    const t = lcsTable(x, y);
    const sa = [];
    const sb = [];
    let same = 0;
    let i = 0;
    let j = 0;
    const push = function (segs, text, changed) {
      const last = segs[segs.length - 1];
      if (last != null && last[1] === changed) {
        last[0] += text;
      } else {
        segs.push([text, changed]);
      }
    };
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        same += x[i].trim() === "" ? 0 : x[i].length;
        push(sa, x[i++], false);
        push(sb, y[j++], false);
      } else if (i < x.length && (j >= y.length || t[i + 1][j] >= t[i][j + 1])) {
        push(sa, x[i++], true);
      } else {
        push(sb, y[j++], true);
      }
    }
    return same * 4 < Math.max(a.trim().length, b.trim().length) ? null : [sa, sb];
  }

  // `side` / `line` say where syntax painting finds the line's tokens.
  function codeNode(text, segs, side, line) {
    const node = el("span", "rv-code");
    node.hl = { side: side, line: line, segs: segs, text: text };
    if (segs == null) {
      node.textContent = text;
      return node;
    }
    segs.forEach(function (sg) {
      node.appendChild(sg[1] ? el("span", "rv-word", sg[0]) : document.createTextNode(sg[0]));
    });
    return node;
  }

  // Highlighted code split into lines of [text, class of the nearest span] runs. `html` comes from CC.markdown.highlight.
  function tokenLines(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const lines = [[]];
    const walk = document.createTreeWalker(tpl.content, SHOW_TEXT);
    for (let t = walk.nextNode(); t != null; t = walk.nextNode()) {
      const cls = t.parentNode.nodeType === 1 ? t.parentNode.className : "";
      t.data.split("\n").forEach(function (s, i) {
        if (i > 0) {
          lines.push([]);
        }
        if (s !== "") {
          lines[lines.length - 1].push([s, cls]);
        }
      });
    }
    return lines;
  }

  // Each side of a hunk is highlighted as one text, so comments and strings spanning lines come out right.
  function hunkTokens(h, highlight, tok) {
    const old = [];
    const neu = [];
    h.lines.forEach(function (l) {
      if (l.charAt(0) !== "+") {
        old.push(l.slice(1));
      }
      if (l.charAt(0) !== "-") {
        neu.push(l.slice(1));
      }
    });
    tokenLines(highlight(old.join("\n"))).forEach(function (runs, i) {
      tok.old.set(h.o + i, runs);
    });
    tokenLines(highlight(neu.join("\n"))).forEach(function (runs, i) {
      tok.new.set(h.n + i, runs);
    });
  }

  // Token runs nested inside the word-diff segments.
  function paintCode(node, runs, segs, text) {
    node.textContent = "";
    let ri = 0;
    let off = 0;
    (segs || [[text, false]]).forEach(function (sg) {
      const host = sg[1] ? node.appendChild(el("span", "rv-word")) : node;
      let left = sg[0].length;
      while (left > 0 && ri < runs.length) {
        const run = runs[ri];
        const take = Math.min(left, run[0].length - off);
        const piece = run[0].substr(off, take);
        host.appendChild(run[1] !== "" ? el("span", run[1], piece) : document.createTextNode(piece));
        left -= take;
        off += take;
        if (off === run[0].length) {
          ri++;
          off = 0;
        }
      }
    });
  }

  function newCount(h) {
    let n = 0;
    h.lines.forEach(function (l) {
      if (l.charAt(0) !== "-") {
        n++;
      }
    });
    return n;
  }

  // The new side of a commit range ("A..B", "A...B", "A.." = A..HEAD); a single revision is diffed against the working tree.
  function rangeHead(range) {
    const m = range.split(/\.\.\.?/);
    return m.length > 1 ? m[1] || "HEAD" : null;
  }

  // Hunks with the context lines expanded so far (`ex`: per gap {top, bottom}; gap i is above hunk i, the last one below the last
  // hunk), and the gaps that still hide lines. Context lines are the same on both sides, so they come from the new side's text and
  // old line numbers follow from the hunk offsets.
  function viewParts(f, ex, text) {
    const parts = [];
    const expandable = !f.binary && f.hunks.length > 0 && !/^(added|untracked|deleted)$/.test(f.status);
    let prev = null;
    let prevEnd = 0;
    f.hunks.forEach(function (h, i) {
      const e = ex[i] || { top: 0, bottom: 0 };
      const from = prevEnd + 1;
      const to = h.n - 1;
      const size = expandable ? to - from + 1 : 0;
      let cur = { o: h.o, n: h.n, head: h.head, lines: h.lines.slice() };
      let hidden = Math.max(0, size);
      if (size > 0 && text != null) {
        const top = prev != null ? Math.min(e.top, size) : 0;
        const bottom = Math.min(e.bottom, size - top);
        for (let k = 0; k < top; k++) {
          prev.lines.push(" " + (text[from - 1 + k] || ""));
        }
        const pre = [];
        for (let k = to - bottom + 1; k <= to; k++) {
          pre.push(" " + (text[k - 1] || ""));
        }
        cur.lines = pre.concat(cur.lines);
        cur.o -= bottom;
        cur.n -= bottom;
        hidden = size - top - bottom;
        if (hidden === 0 && prev != null) {
          prev.lines = prev.lines.concat(cur.lines);
          cur = null;
        }
      }
      if (cur != null) {
        parts.push({ gap: i, hidden: hidden, first: prev == null, head: h.head || "" });
        parts.push({ hunk: cur });
        prev = cur;
      }
      prevEnd = Math.max(prevEnd, h.n + newCount(h) - 1);
    });
    if (expandable) {
      const n = f.hunks.length;
      if (text == null) {
        parts.push({ gap: n, hidden: null, trailing: true, head: "" });
      } else {
        const size = text.length - prevEnd;
        const top = Math.min((ex[n] || { top: 0 }).top, Math.max(0, size));
        for (let k = 0; k < top; k++) {
          prev.lines.push(" " + text[prevEnd + k]);
        }
        if (size - top > 0) {
          parts.push({ gap: n, hidden: size - top, trailing: true, head: "" });
        }
      }
    }
    return parts;
  }

  // Index of the paired line for each removed / added line of a hunk (runs of − followed by runs of +).
  function partners(lines) {
    const map = new Map();
    let i = 0;
    while (i < lines.length) {
      if (lines[i].charAt(0) !== "-") {
        i++;
        continue;
      }
      const d = i;
      while (i < lines.length && lines[i].charAt(0) === "-") {
        i++;
      }
      const a = i;
      while (i < lines.length && lines[i].charAt(0) === "+") {
        i++;
      }
      for (let k = 0; k < Math.min(a - d, i - a); k++) {
        map.set(d + k, a + k);
        map.set(a + k, d + k);
      }
    }
    return map;
  }

  // Del/add runs are paired line by line; context lines fill both sides.
  function splitRows(h) {
    const rows = [];
    let o = h.o;
    let n = h.n;
    let dels = [];
    let adds = [];
    const flush = function () {
      for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
        rows.push({ l: dels[i] || null, r: adds[i] || null });
      }
      dels = [];
      adds = [];
    };
    h.lines.forEach(function (line) {
      const sign = line.charAt(0);
      const code = line.slice(1);
      if (sign === "-") {
        dels.push({ sign: "-", line: o, code: code });
        o += 1;
      } else if (sign === "+") {
        adds.push({ sign: "+", line: n, code: code });
        n += 1;
      } else {
        flush();
        rows.push({ l: { sign: " ", line: o, code: code }, r: { sign: " ", line: n, code: code } });
        o += 1;
        n += 1;
      }
    });
    flush();
    return rows;
  }

  // How many rows a file's body will have, for a placeholder of about the right height.
  function rowCount(f, split) {
    let rows = 0;
    f.hunks.forEach(function (h) {
      rows += 1;
      if (!split) {
        rows += h.lines.length;
        return;
      }
      let dels = 0;
      let adds = 0;
      h.lines.forEach(function (l) {
        const sign = l.charAt(0);
        if (sign === "-") {
          dels++;
        } else if (sign === "+") {
          adds++;
        } else {
          rows += Math.max(dels, adds) + 1;
          dels = 0;
          adds = 0;
        }
      });
      rows += Math.max(dels, adds);
    });
    return rows;
  }

  function squeeze(s) {
    return s.replace(/\s+/g, "");
  }

  // One run of removed and added lines with the pairs that differ only in whitespace turned into context, matched as a longest common
  // subsequence so the numbering stays valid.
  function stripRun(dels, adds, out) {
    if (dels.length * adds.length > LCS_CELLS || dels.length === 0 || adds.length === 0) {
      dels.forEach(function (l) {
        out.push("-" + l);
      });
      adds.forEach(function (l) {
        out.push("+" + l);
      });
      return;
    }
    const x = dels.map(squeeze);
    const y = adds.map(squeeze);
    const t = lcsTable(x, y);
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        out.push(" " + adds[j]);
        i++;
        j++;
      } else if (i < x.length && (j >= y.length || t[i + 1][j] >= t[i][j + 1])) {
        out.push("-" + dels[i++]);
      } else {
        out.push("+" + adds[j++]);
      }
    }
  }

  // A copy of the file roughly as `git diff -w` would show it; the reader's diff has no such option. `onlySpace`: nothing is left.
  function stripWhitespace(f) {
    let add = 0;
    let del = 0;
    const hunks = [];
    f.hunks.forEach(function (h) {
      const lines = [];
      let dels = [];
      let adds = [];
      h.lines.forEach(function (l) {
        const sign = l.charAt(0);
        if (sign === "-") {
          dels.push(l.slice(1));
        } else if (sign === "+") {
          adds.push(l.slice(1));
        } else {
          stripRun(dels, adds, lines);
          dels = [];
          adds = [];
          lines.push(l);
        }
      });
      stripRun(dels, adds, lines);
      let changed = 0;
      lines.forEach(function (l) {
        const sign = l.charAt(0);
        add += sign === "+" ? 1 : 0;
        del += sign === "-" ? 1 : 0;
        changed += sign === "+" || sign === "-" ? 1 : 0;
      });
      if (changed > 0) {
        hunks.push({ o: h.o, n: h.n, head: h.head, lines: lines });
      }
    });
    return Object.assign({}, f, { hunks: hunks, add: add, del: del, onlySpace: f.hunks.length > 0 && hunks.length === 0 });
  }

  function hash(text) {
    let a = 0x811c9dc5;
    let b = 0x1b873593;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x5bd1e995);
      b ^= b >>> 13;
    }
    return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
  }

  // What a viewed mark is tied to: the change itself.
  function signature(f) {
    const parts = [f.status, f.old || "", f.binary ? "b" : "", f.truncated ? "t" : ""];
    f.hunks.forEach(function (h) {
      parts.push(h.lines.join("\n"));
    });
    return hash(parts.join("\0"));
  }

  const GENERATED = /(^|\/)(dist|generated|__generated__|__snapshots__)\/|\.min\.(js|css)$|\.generated\.|\.g\.dart$|\.pb\.go$|\.snap$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|Gemfile\.lock)$/;
  const TEST = /(^|\/)(tests?|__tests__|specs?|e2e|cypress|fixtures)\/|[._-](test|spec)\.[^./]+$|Tests?\.(java|kt|cs|swift)$|(^|\/)test_[^/]+\.py$/;
  const BUILD = /(^|\/)(package\.json|Makefile|Dockerfile|docker-compose\.ya?ml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|pom\.xml|Cargo\.toml|go\.mod|pyproject\.toml|setup\.py|CMakeLists\.txt|tsconfig[^/]*\.json|\.gitlab-ci\.yml)$|(^|\/)\.github\/workflows\//;

  function fileGroup(path) {
    if (GENERATED.test(path)) {
      return "generated";
    }
    if (TEST.test(path)) {
      return "test";
    }
    return BUILD.test(path) ? "build" : "code";
  }

  function dirOf(path) {
    const slash = path.lastIndexOf("/");
    return slash > 0 ? path.slice(0, slash) : "";
  }

  function baseOf(path) {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  // Grey path with its middle left out: "src/…/widgets".
  function shortDir(dir, max) {
    const limit = max || 26;
    if (dir.length <= limit) {
      return dir;
    }
    const parts = dir.split("/");
    if (parts.length < 3) {
      return dir.slice(0, limit - 1) + "…";
    }
    return parts[0] + "/…/" + parts[parts.length - 1];
  }

  function quote(code) {
    const s = code.trim();
    if (s === "") {
      return "empty line";
    }
    const clipped = s.length > 120 ? s.slice(0, 120) + "…" : s;
    return clipped.indexOf("`") >= 0 ? "`` " + clipped + " ``" : "`" + clipped + "`";
  }

  function where(c) {
    return c.from != null && c.from.line !== c.line ? c.from.line + "-" + c.line : String(c.line);
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  // The one message: comments in file order, grouped by the diff they were written on. CC.reviewNote parses this text back.
  function message(comments, paths) {
    const order = new Map();
    paths.forEach(function (p, i) {
      order.set(p, i);
    });
    const sorted = comments.slice().sort(function (a, b) {
      const fa = order.has(a.path) ? order.get(a.path) : order.size;
      const fb = order.has(b.path) ? order.get(b.path) : order.size;
      return fa - fb || a.path.localeCompare(b.path) || a.line - b.line;
    });
    const groups = new Map();
    sorted.forEach(function (c) {
      const src = c.src || WORKTREE_ID;
      if (!groups.has(src)) {
        groups.set(src, { label: c.srcLabel || WORKTREE_LABEL, lines: [] });
      }
      const code = c.from != null ? quote(c.from.code) + " … " + quote(c.code) : quote(c.code);
      const what = c.sign === " " || c.from != null ? code : c.sign + " " + code;
      groups.get(src).lines.push("- " + c.path + ":" + where(c) + " (" + what + "): " + c.text.replace(/\n/g, "\n  "));
    });
    const parts = [];
    groups.forEach(function (g) {
      const head = groups.size === 1 && g.label === WORKTREE_LABEL ? "Review comments on the current diff:" : "Review comments on " + g.label + ":";
      parts.push(head + "\n" + g.lines.join("\n"));
    });
    return parts.join("\n\n");
  }

  return {
    WORKTREE_ID: WORKTREE_ID, WORKTREE_LABEL: WORKTREE_LABEL, anchorKey: anchorKey, keyOf: keyOf, pathOfKey: pathOfKey, wordDiff: wordDiff,
    codeNode: codeNode, tokenLines: tokenLines, hunkTokens: hunkTokens, paintCode: paintCode, rangeHead: rangeHead, viewParts: viewParts,
    partners: partners, splitRows: splitRows, rowCount: rowCount, stripWhitespace: stripWhitespace, hash: hash, signature: signature,
    fileGroup: fileGroup, dirOf: dirOf, baseOf: baseOf, shortDir: shortDir, quote: quote, where: where, plural: plural, message: message,
  };
})();
