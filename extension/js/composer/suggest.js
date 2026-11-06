// Claude Code's next-prompt suggestion as the placeholder while idle; Tab or → accepts it.
CC.Composer.use(function (composer) {
  function sync() {
    const text = composer.status === "idle" ? composer.meta.suggestion || null : null;
    if (composer.suggestion !== text) {
      composer.suggestion = text;
      composer.refresh();
    }
    return false;
  }

  composer.on("meta", sync);
  composer.on("status", sync);

  composer.on("keydown", function (e) {
    if ((e.key === "Tab" || e.key === "ArrowRight") && !e.shiftKey && composer.suggestion != null && composer.input.value === "") {
      composer.setValue(composer.suggestion);
      return true;
    }
    return false;
  });
});
