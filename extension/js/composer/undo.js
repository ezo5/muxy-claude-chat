window.CC = window.CC || {};

// Own undo stack: native textarea undo is lost whenever setValue() assigns the value programmatically.
CC.Composer.use(function (composer) {
  const ta = composer.input;
  const MAX = 200;
  const MERGE_MS = 1000;
  let stack = [{ v: "", s: 0, e: 0 }];
  let at = 0;
  let lastAt = 0;
  let restoring = false;

  function snapshot() {
    return { v: ta.value, s: ta.selectionStart, e: ta.selectionEnd };
  }

  composer.on("input", function (arg) {
    if (restoring || ta.value === stack[at].v) {
      return false;
    }
    const now = Date.now();
    const typed = arg == null || !arg.programmatic;
    stack.length = at + 1;
    if (typed && lastAt > 0 && now - lastAt < MERGE_MS && at > 0) {
      stack[at] = snapshot();
    } else {
      stack.push(snapshot());
      if (stack.length > MAX) {
        stack.shift();
      }
      at = stack.length - 1;
    }
    lastAt = typed ? now : 0;
    return false;
  });

  function go(step) {
    const next = at + step;
    if (next < 0 || next >= stack.length) {
      return;
    }
    at = next;
    lastAt = 0;
    const snap = stack[at];
    restoring = true;
    composer.setValue(snap.v);
    restoring = false;
    ta.setSelectionRange(snap.s, snap.e);
  }

  composer.on("keydown", function (e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) {
      return false;
    }
    const k = e.key.toLowerCase();
    if (k === "z") {
      go(e.shiftKey ? 1 : -1);
      return true;
    }
    if (k === "y" && !e.shiftKey) {
      go(1);
      return true;
    }
    return false;
  });
});
