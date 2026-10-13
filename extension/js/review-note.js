window.CC = window.CC || {};

// The message Review.send() writes, rendered as cards in the user bubble; parsed from text so reloads look the same.
CC.reviewNote = (function () {
  const util = CC.util;
  const el = util.el;
  const HEAD = /^Review comments on (.+):$/;
  const TURN = /^your edits in the turn "(.*)"$/;
  const ITEM = /^- (.+?):(\d+(?:-\d+)?) \(/;

  // `code`, `` co`de `` or "empty line" at s[i]; returns [code, next index] or null.
  function quoted(s, i) {
    if (s.startsWith("empty line", i)) {
      return ["", i + 10];
    }
    if (s.startsWith("`` ", i)) {
      const end = s.indexOf(" ``", i + 3);
      return end < 0 ? null : [s.slice(i + 3, end), end + 3];
    }
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      return end < 0 ? null : [s.slice(i + 1, end), end + 1];
    }
    return null;
  }

  function item(line) {
    const m = ITEM.exec(line);
    if (m == null) {
      return null;
    }
    let i = m[0].length;
    let sign = " ";
    if ((line[i] === "+" || line[i] === "-") && line[i + 1] === " ") {
      sign = line[i];
      i += 2;
    }
    const first = quoted(line, i);
    if (first == null) {
      return null;
    }
    let from = null;
    let code = first[0];
    i = first[1];
    if (line.startsWith(" … ", i)) {
      const last = quoted(line, i + 3);
      if (last == null) {
        return null;
      }
      from = first[0];
      code = last[0];
      i = last[1];
    }
    if (!line.startsWith("): ", i)) {
      return null;
    }
    return { path: m[1], line: m[2], sign: sign, from: from, code: code, text: line.slice(i + 3) };
  }

  function parse(text) {
    const groups = [];
    let cur = null;
    const lines = text.split("\n");
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      const head = HEAD.exec(line);
      if (head != null) {
        cur = { label: head[1], items: [] };
        groups.push(cur);
      } else if (cur != null && line.startsWith("- ")) {
        const it = item(line);
        if (it == null) {
          return null;
        }
        cur.items.push(it);
      } else if (cur != null && cur.items.length > 0 && line.startsWith("  ")) {
        const last = cur.items[cur.items.length - 1];
        last.text += "\n" + line.slice(2);
      } else if (line !== "" || cur == null) {
        return null;
      }
    }
    return groups.length > 0 && groups.every(function (g) {
      return g.items.length > 0;
    }) ? groups : null;
  }

  function codeLine(sign, code) {
    const row = el("div", "rvm-code" + (sign === "+" ? " add" : sign === "-" ? " del" : ""));
    row.append(el("span", "rvm-sign", sign === " " ? "" : sign), el("span", "rvm-src", code === "" ? "empty line" : code));
    return row;
  }

  function render(groups) {
    const box = el("div", "bubble-text rvm");
    groups.forEach(function (g) {
      const head = el("div", "rvm-head");
      const n = g.items.length;
      const turn = TURN.exec(g.label);
      const ctx = el("span", "rvm-ctx", turn != null ? "“" + turn[1] + "”" : g.label);
      ctx.title = "Review comments on " + g.label;
      head.append(util.icon("diff"), el("span", "rvm-title", "Review"), el("span", "rvm-count", n + (n === 1 ? " comment" : " comments")), ctx);
      box.appendChild(head);
      g.items.forEach(function (it) {
        const card = el("div", "rvm-item");
        const loc = el("div", "rvm-loc");
        loc.title = it.path + ":" + it.line;
        const slash = it.path.lastIndexOf("/");
        loc.append(el("span", "rvm-file", it.path.slice(slash + 1)), el("span", "rvm-line", ":" + it.line));
        if (slash > 0) {
          loc.appendChild(el("span", "rvm-dir", it.path.slice(0, slash)));
        }
        card.appendChild(loc);
        const code = el("div", "rvm-snippet");
        if (it.from != null) {
          code.append(codeLine(it.sign, it.from), el("div", "rvm-gap", "⋮"));
        }
        code.appendChild(codeLine(it.sign, it.code));
        const text = el("div", "rvm-text");
        it.text.split(/\n\s*\n/).forEach(function (para) {
          text.appendChild(el("p", "", para));
        });
        card.append(code, text);
        box.appendChild(card);
      });
    });
    return box;
  }

  return { parse: parse, render: render };
})();
