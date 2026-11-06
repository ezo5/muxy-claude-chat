// The quiet row under the field. Left: permission mode in plain words, a click moves to the next one. Right: model and effort; a click opens
// the pickers of app/js/commands/. The ring is another slot item (C5).
CC.Composer.use(function (composer) {
  const CYCLE = { default: "acceptEdits", acceptEdits: "plan", plan: "auto", auto: "default" };
  const MODES = { default: "Ask before edits", acceptEdits: "Accept edits", plan: "Plan", auto: "Auto", bypassPermissions: "Bypass permissions", dontAsk: "Don't ask" };
  let busy = false;

  function quiet(label, onClick) {
    const b = CC.util.el("button", "cmp-quiet");
    b.type = "button";
    b.title = label;
    b.hidden = true;
    b.addEventListener("click", onClick);
    return b;
  }

  function show(b, text) {
    b.hidden = text == null;
    b.textContent = text || "";
  }

  const mode = quiet("Change permission mode", async function () {
    if (busy) {
      return;
    }
    busy = true;
    try {
      await composer.deps.control("set_permission_mode", { mode: CYCLE[composer.meta.permissionMode] || "default" });
    } catch (e) {
      CC.ui.toast("Mode change failed: " + (e && e.message ? e.message : e), { level: "error" });
    } finally {
      busy = false;
    }
  });
  composer.belowLeft.appendChild(mode);

  const model = quiet("Change model", function () {
    CC.Pickers.openModel(composer);
  });
  const effort = quiet("Change effort", function () {
    CC.Pickers.openEffort(composer);
  });
  composer.belowRight.append(model, effort);

  composer.on("meta", function (meta) {
    const m = meta.permissionMode;
    show(mode, m != null ? MODES[m] || m : null);
    show(model, CC.Pickers.modelLabel(meta) || null);
    show(effort, meta.effort != null ? String(meta.effort).replace(/^./, function (c) {
      return c.toUpperCase();
    }) : null);
    return false;
  });
});
