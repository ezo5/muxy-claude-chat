window.CC = window.CC || {};

// Claude Code's next-prompt suggestion (`prompt_suggestion` event) as the placeholder while idle; Tab or → accepts it.
CC.Composer.use(function (composer) {
  function sync() {
    const text = composer.status === "idle" ? composer.meta.suggestion || null : null;
    if (composer.suggestion !== text) {
      composer.suggestion = text;
      composer.refresh();
    }
  }

  composer.suggestion = null;
  composer.on("meta", function () {
    sync();
    return false;
  });
  composer.on("status", function () {
    sync();
    return false;
  });

  composer.on("keydown", function (e) {
    if ((e.key === "Tab" || e.key === "ArrowRight") && !e.shiftKey && composer.suggestion != null && composer.input.value === "") {
      composer.setValue(composer.suggestion);
      return true;
    }
    return false;
  });
});
