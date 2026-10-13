window.CC = window.CC || {};

CC.Composer.use(function (composer) {
  const key = "draft:" + CC.host.viewId();
  let timer = null;
  let loaded = false;

  composer.on("input", function () {
    if (!loaded) {
      return false;
    }
    clearTimeout(timer);
    timer = setTimeout(function () {
      CC.host.storageSet(key, composer.value() || null);
    }, 500);
    return false;
  });

  CC.host.storageGet(key).then(function (draft) {
    if (typeof draft === "string" && draft !== "" && composer.value() === "") {
      composer.setValue(draft);
    }
    loaded = true;
  });
});
