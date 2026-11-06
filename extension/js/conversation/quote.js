// Quoted reply text in a prompt: `>` blocks before the question, one per quote (a bare `>` keeps a paragraph break).
CC.quote = (function () {
  function block(quotes) {
    return quotes.map(function (q) {
      return q.split("\n").map(function (l) {
        return l.trim() === "" ? ">" : "> " + l;
      }).join("\n");
    }).join("\n\n");
  }

  // {quotes, rest}: the leading quote blocks of a prompt and the text after them.
  function split(text) {
    const lines = text.split("\n");
    const quotes = [];
    let cur = null;
    let i = 0;
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (/^>/.test(l)) {
        cur = cur || [];
        cur.push(l.replace(/^> ?/, ""));
      } else if (l.trim() === "" && cur != null) {
        quotes.push(cur.join("\n").trim());
        cur = null;
      } else {
        break;
      }
    }
    if (cur != null) {
      quotes.push(cur.join("\n").trim());
    }
    return { quotes: quotes.filter(Boolean), rest: lines.slice(i).join("\n").trim() };
  }

  return { block: block, split: split };
})();
