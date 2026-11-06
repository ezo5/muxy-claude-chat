// Small pieces every file of the conversation shares. Nothing here holds state of a chat.
Object.assign(CC.icons, {
  brain: '<path d="M12 5a3 3 0 0 0-5.900-.700A3 3 0 0 0 4 9.500a3 3 0 0 0 .5 5.600A3.500 3.500 0 0 0 12 18z"/><path d="M12 5a3 3 0 0 1 5.900-.700A3 3 0 0 1 20 9.500a3 3 0 0 1-.5 5.600A3.500 3.500 0 0 1 12 18z"/><path d="M12 5v15"/>',
  quote: '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
  reply: '<path d="M20 18v-2a4 4 0 0 0-4-4H4"/><path d="m9 17-5-5 5-5"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  minus: '<path d="M5 12h14"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  diff: '<path d="M12 3v14"/><path d="M5 10h14"/><path d="M5 21h14"/>',
  dots: '<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
});

CC.conv = (function () {
  const el = CC.util.el;

  function copyButton(getText, label) {
    const b = CC.ui.iconButton({ icon: "copy", label: label || "Copy", size: 14 });
    b.classList.add("cv-copy");
    b.addEventListener("click", async function (e) {
      e.stopPropagation();
      const ok = await CC.util.copyText(getText());
      b.classList.add(ok ? "is-copied" : "is-copy-failed");
      setTimeout(function () {
        b.classList.remove("is-copied", "is-copy-failed");
      }, 1200);
    });
    return b;
  }

  function action(icon, label, run) {
    const b = CC.ui.iconButton({ icon: icon, label: label, size: 14 });
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      run(b, e);
    });
    return b;
  }

  function baseName(p) {
    const s = String(p || "").replace(/\/+$/, "");
    return s.slice(s.lastIndexOf("/") + 1) || s;
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  function humanize(name) {
    const s = String(name || "").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function tsMs(ts) {
    return typeof ts === "number" ? ts : ts ? Date.parse(ts) : NaN;
  }

  function fullTime(ts) {
    const t = tsMs(ts);
    return isNaN(t) ? "" : new Date(t).toLocaleString();
  }

  function timeEl(ts) {
    const t = el("span", "cv-time", CC.util.fmtTime(tsMs(ts)));
    t.title = fullTime(ts);
    return t;
  }

  // Bash and fetch tools print ANSI-free text with tool_use_error tags.
  function resultText(result) {
    return String(result.text || "").replace(/<\/?tool_use_error>/g, "").replace(/^\s+|\s+$/g, "");
  }

  return { copyButton: copyButton, action: action, baseName: baseName, plural: plural, humanize: humanize, tsMs: tsMs, fullTime: fullTime, timeEl: timeEl, resultText: resultText };
})();
