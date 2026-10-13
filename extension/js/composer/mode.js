window.CC = window.CC || {};

// Permission-mode chip in the toolbar: cycles default → acceptEdits → plan → default through set_permission_mode.
CC.Composer.use(function (composer) {
  const util = CC.util;
  const el = util.el;
  const CYCLE = { default: "acceptEdits", acceptEdits: "plan", plan: "default" };
  const MODES = { default: "Ask before edits", acceptEdits: "Accept edits", plan: "Plan mode", auto: "Auto", bypassPermissions: "Bypass permissions", dontAsk: "Don't ask" };
  let busy = false;

  const chip = el("button", "mode-chip hidden");
  chip.type = "button";
  chip.title = "Cycle permission mode";
  chip.addEventListener("click", async function () {
    if (busy) {
      return;
    }
    const next = CYCLE[composer.meta.permissionMode] || "default";
    busy = true;
    chip.classList.add("pulse");
    try {
      await composer.deps.control("set_permission_mode", { mode: next });
    } catch (e) {
      util.toast("Mode change failed: " + (e && e.message ? e.message : e), "error");
    } finally {
      busy = false;
      chip.classList.remove("pulse");
    }
  });
  composer.left.appendChild(chip);

  composer.on("meta", function (meta) {
    const m = meta.permissionMode;
    chip.classList.toggle("hidden", m == null);
    chip.textContent = MODES[m] || m || "";
    chip.dataset.mode = m || "";
    return false;
  });
});
