window.CC = window.CC || {};

CC.Composer.use(function (composer) {
  const owner = { name: "mention" };
  let timer = null;
  let seq = 0;

  function token() {
    const ta = composer.input;
    const before = ta.value.slice(0, ta.selectionStart);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (m == null) {
      return null;
    }
    return { q: m[2], start: ta.selectionStart - m[2].length - 1 };
  }

  function update(ev) {
    if (ev != null && ev.programmatic === true) {
      return false;
    }
    const t = token();
    clearTimeout(timer);
    if (t == null) {
      if (composer.popup.isOpen(owner)) {
        composer.popup.close();
      }
      return;
    }
    const mine = ++seq;
    timer = setTimeout(async function () {
      let files = [];
      try {
        files = await composer.deps.files(t.q);
      } catch (e) {
        console.warn("file search failed", e && e.message);
        return;
      }
      if (mine !== seq || token() == null) {
        return;
      }
      composer.popup.open(owner, files.map(function (f) {
        const slash = f.replace(/\/$/, "").lastIndexOf("/");
        return { label: f.slice(slash + 1), desc: slash > 0 ? f.slice(0, slash + 1) : "", path: f };
      }), { title: "Files" });
    }, 140);
  }

  owner.onPick = function (it) {
    const t = token();
    if (t == null) {
      return;
    }
    const ta = composer.input;
    const after = ta.value.slice(ta.selectionStart);
    const insert = "@" + it.path + (it.path.slice(-1) === "/" ? "" : " ");
    const value = ta.value.slice(0, t.start) + insert + after;
    composer.setValue(value);
    const pos = t.start + insert.length;
    ta.setSelectionRange(pos, pos);
    if (it.path.slice(-1) === "/") {
      update(null);
    }
  };

  composer.on("input", update);
});
