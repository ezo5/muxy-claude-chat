// Text quoted from Claude's replies: chips above the field, sent as `>` blocks before the prompt.
CC.Composer.use(function (composer) {
  const el = CC.util.el;
  const MAX = 4000;
  let quotes = [];
  const row = el("div", "cmp-chip-row");
  composer.chips.appendChild(row);

  function render() {
    row.textContent = "";
    quotes.forEach(function (q, i) {
      const chip = el("div", "cmp-chip cmp-quote");
      chip.title = q;
      chip.appendChild(CC.ui.icon("quote", 14));
      chip.appendChild(el("span", "cmp-chip-text", q.replace(/\s+/g, " ")));
      chip.appendChild(CC.ui.iconButton({
        icon: "x",
        label: "Remove quote",
        size: 12,
        onClick: function () {
          quotes.splice(i, 1);
          render();
          composer.focus();
        },
      }));
      row.appendChild(chip);
    });
    composer.refresh();
  }

  composer.addQuote = function (text) {
    const t = (text || "").trim();
    if (t === "") {
      return;
    }
    quotes.push(t.length > MAX ? t.slice(0, MAX) + "…" : t);
    render();
    composer.focus();
  };

  composer.on("collect", function (entry) {
    if (quotes.length > 0) {
      entry.text = CC.quote.block(quotes) + (entry.text.trim() !== "" ? "\n\n" + entry.text : "");
    }
    return false;
  });

  composer.on("submitted", function () {
    if (quotes.length > 0) {
      quotes = [];
      render();
    }
    return false;
  });
});
